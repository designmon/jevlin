#!/usr/bin/env node
/**
 * jev — fast judgement calls for coding agents.
 *
 * Jev answers many yes/no questions in one round trip and does not write. This CLI wraps
 * that for a shell: candidates on stdin, the ones that matter on stdout, a receipt on
 * stderr, and an exit code the caller can trust.
 *
 * The contract that matters: exit 1 means Jev considered it and said no; exit 3 means Jev
 * never saw it, so do it the slow way. Exit 3 always prints nothing, so a naive
 * `jev filter ... | xargs cat` fails loudly rather than quietly working on a truncated world.
 *
 * Measured 2026-09-23 (see SPIKE-RESULTS.md): against a lexical baseline it is ~3x better at
 * putting a relevant file in the top 10. It LOCATES well (small changes: recall@10 0.77,
 * median first hit at rank 3) and ENUMERATES badly (large changes: recall@10 0.17). Treat
 * its output as a starting point, never as the complete set.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveKey, decide, chunkCandidates, est, CHUNK_TOKEN_BUDGET, MAX_Q, JEV_MODEL } from './core.mjs'

const EX = { OK: 0, NO: 1, USAGE: 2, DEGRADED: 3, PARTIAL: 4 }
const LOG = process.env.JEV_LOG || join(homedir(), '.local/state/jev/usage.jsonl')
const DAILY_CAP_USD = Number(process.env.JEV_DAILY_CAP ?? 1)
const started = Date.now()

// ---------------------------------------------------------------- argv

function parseArgs(argv) {
  const flags = {}, rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { rest.push(a); continue }
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    const NEEDS = ['min', 'top', 'timeout', 'context', 'context-file', 'key', 'concurrency', 'peek', 'sep']
    let val
    if (eq > 0) val = a.slice(eq + 1)
    else if (NEEDS.includes(name)) val = argv[++i]
    else val = true
    if (name === 'context') (flags.context ??= []).push(val)
    else flags[name] = val
  }
  return { flags, rest }
}

const die = (msg) => { process.stderr.write(`jev: ${msg}\nreason=usage\n`); process.exit(EX.USAGE) }

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const bufs = []
  for await (const c of process.stdin) bufs.push(c)
  return Buffer.concat(bufs).toString('utf8')
}

// ---------------------------------------------------------------- log

function writeLog(row) {
  if (process.env.JEV_NO_LOG) return
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n')
  } catch { /* logging must never break the run */ }
}

function spentToday() {
  try {
    const day = new Date().toISOString().slice(0, 10)
    let total = 0
    for (const line of readFileSync(LOG, 'utf8').split('\n')) {
      if (!line || !line.includes(day)) continue
      try { const r = JSON.parse(line); if (r.t?.startsWith(day)) total += r.cost ?? 0 } catch {}
    }
    return total
  } catch { return 0 }
}

// ---------------------------------------------------------------- candidates

function parseCandidates(text, flags) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.replace(/\r$/, '')
    if (!s.trim()) continue
    const tab = s.indexOf('\t')
    // Everything before the first TAB is the key we echo; everything after is context for
    // Jev that never appears on stdout. No TAB means the line is both, so `rg -n` output
    // works unmodified.
    const key = tab >= 0 ? s.slice(0, tab) : s
    const desc = tab >= 0 ? s.slice(tab + 1) : s
    out.push({ key, desc, i: out.length })
  }
  return out
}

function peekFile(path, lines) {
  try {
    const buf = readFileSync(path)
    if (buf.includes(0)) return null                    // binary
    return buf.toString('utf8').split('\n').slice(0, lines).map((l) => l.slice(0, 200)).join(' ⏎ ')
  } catch { return null }
}

// ---------------------------------------------------------------- filter

async function cmdFilter(instructions, flags) {
  if (!instructions) die('filter needs instructions: jev filter "what makes a candidate relevant"')
  const cands = parseCandidates(await readStdin(), flags)
  if (!cands.length) die('no candidates on stdin')

  const { key, source } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) return emit({ exit: EX.DEGRADED, reason: 'no-key', note: 'no API key; run `jev check`' }, flags)
  if (spentToday() >= DAILY_CAP_USD)
    return emit({ exit: EX.DEGRADED, reason: 'cap', note: `daily cap $${DAILY_CAP_USD} reached` }, flags)

  const context = [].concat(flags.context ?? [])
  if (typeof flags['context-file'] === 'string') {
    try { context.push(readFileSync(flags['context-file'], 'utf8')) } catch { die(`cannot read ${flags['context-file']}`) }
  }
  const state = { request: instructions, ...(context.length ? { context: context.join('\n') } : {}) }

  const peekLines = flags.peek === true ? 20 : flags.peek ? Number(flags.peek) : 0
  if (peekLines) for (const c of cands) { const p = peekFile(c.key, peekLines); if (p) c.desc = `${c.key} — ${p}` }

  const room = CHUNK_TOKEN_BUDGET - est(state) - 200
  const chunks = chunkCandidates(cands, (c) => est(c.desc) + 30, { room, maxQ: MAX_Q.noul })
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 20_000

  const settled = await Promise.all(chunks.map(async (items) => {
    const questions = Object.fromEntries(items.map((c) => [`c${c.i}`, {
      type: 'noul', instructions: `${instructions}\n\nDoes this one qualify: ${c.desc}`,
    }]))
    return [await decide(key, state, questions, { timeoutMs }), items]
  }))

  const scores = new Map()
  let cost = 0, inTok = 0, ms = 0, unjudged = 0, failed = 0, firstReason = null
  for (const [o, items] of settled) {
    if (!o.ok) { failed++; firstReason ??= o.reason; unjudged += items.length; continue }
    cost += o.cost; inTok += o.inTok; ms = Math.max(ms, o.ms)
    for (const c of items) {
      const a = o.answers[`c${c.i}`]
      // Absence of judgement is not a negative judgement: an unanswered candidate is kept.
      if (a) scores.set(c.key, Math.max(scores.get(c.key) ?? 0, a.noul))
      else { scores.set(c.key, Math.max(scores.get(c.key) ?? 0, 0.5)); unjudged++ }
    }
  }

  if (failed === chunks.length)
    return emit({ exit: EX.DEGRADED, reason: firstReason, note: `all ${chunks.length} chunk(s) failed` }, flags)

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const vals = ranked.map(([, v]) => v).slice().sort((a, b) => a - b)
  const q = (f) => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))] ?? 0
  // Flat AND undecided. A tight cluster near 0 is a confident "none of these qualify",
  // which is an answer; a tight cluster near 0.5 is Jev not understanding the question.
  const median = q(0.5)
  const spread = median > 0.3 && median < 0.7 ? q(0.95) - q(0.05) : 1

  const hasMin = flags.min !== undefined
  const min = hasMin ? Number(flags.min) : 0
  // Rank cuts, not threshold cuts: a rank survives miscalibration, a threshold does not.
  const top = flags.all ? ranked.length : flags.top ? Number(flags.top) : 20
  let kept = ranked.filter(([, v]) => v >= min).slice(0, top)

  const order = new Map(cands.map((c) => [c.key, c.i]))
  if (!flags.rank && !flags.all) kept = kept.slice().sort((a, b) => order.get(a[0]) - order.get(b[0]))

  const receipt =
    `jev filter · ${cands.length} cand · ${chunks.length} chunk${chunks.length > 1 ? 's' : ''} · ` +
    `${((Date.now() - started) / 1000).toFixed(2)}s · $${cost.toFixed(5)} · kept ${kept.length}/${cands.length}` +
    (hasMin ? ` · min ${min}` : ` · top ${top}`) + ` · key=${source}`

  const lines = kept.map(([k, v]) => (flags.scores ? `${v.toFixed(2)}\t${k}` : k))
  const base = { cmd: 'filter', n: cands.length, chunks: chunks.length, kept: kept.length, cost, inTok,
    estTok: est(state) + cands.reduce((a, c) => a + est(c.desc) + 30, 0), ms, unjudged, inst: instructions.slice(0, 200) }

  if (failed) {
    return emit({ exit: EX.PARTIAL, lines, receipt, reason: 'partial',
      note: `unjudged ${unjudged}/${cands.length} (${failed} chunk(s): ${firstReason})`, spread, base, flags }, flags)
  }
  if (!kept.length) {
    const near = ranked.slice(0, 3).map(([k, v]) => `${v.toFixed(2)} ${k}`).join(', ')
    return emit({ exit: flags['none-ok'] ? EX.OK : EX.NO, lines: [], receipt, reason: 'none-cleared',
      note: `nothing cleared min=${min} · best: ${near}`, spread, base, flags }, flags)
  }
  return emit({ exit: EX.OK, lines, receipt, spread, base, flags }, flags)
}

// ---------------------------------------------------------------- ask

async function cmdAsk(instructions, flags) {
  if (!instructions) die('ask needs a question: jev ask "the build succeeded"')
  let blob = await readStdin()
  if (!blob.trim()) die('no text on stdin')
  // Truncate from the middle: the head and tail of a log carry the signal, the middle repeats.
  const CAP = 60_000
  let truncated = false
  if (blob.length > CAP) { blob = blob.slice(0, CAP / 2) + '\n…[truncated]…\n' + blob.slice(-CAP / 2); truncated = true }

  const { key, source } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) return emit({ exit: EX.DEGRADED, reason: 'no-key', note: 'no API key; run `jev check`' }, flags)

  const out = await decide(key, { text: blob }, { a: { type: 'noul', instructions } },
    { timeoutMs: flags.timeout ? Number(flags.timeout) : 20_000 })
  if (!out.ok) return emit({ exit: EX.DEGRADED, reason: out.reason, note: out.error }, flags)

  const p = out.answers.a?.noul
  if (typeof p !== 'number') return emit({ exit: EX.DEGRADED, reason: 'parse', note: 'no answer' }, flags)
  const min = flags.min !== undefined ? Number(flags.min) : 0.5
  const receipt = `jev ask · ${((Date.now() - started) / 1000).toFixed(2)}s · $${out.cost.toFixed(5)} · p=${p.toFixed(2)} min=${min}` +
    (truncated ? ' · INPUT TRUNCATED' : '') + ` · key=${source}`
  writeLog({ cmd: 'ask', p, min, cost: out.cost, ms: out.ms, exit: p >= min ? 0 : 1, inst: instructions.slice(0, 200) })
  process.stderr.write(receipt + '\n')
  if (flags.p) process.stdout.write(p.toFixed(4) + '\n')
  if (p < min) process.stderr.write(`reason=below-min\n`)
  process.exit(p >= min ? EX.OK : EX.NO)
}

// ---------------------------------------------------------------- raw / check / stats

async function cmdRaw(flags) {
  const body = await readStdin()
  let parsed
  try { parsed = JSON.parse(body) } catch { die('stdin must be JSON: {"state":…,"questions":…}') }
  const { key } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) return emit({ exit: EX.DEGRADED, reason: 'no-key', note: 'no API key' }, flags)
  const out = await decide(key, parsed.state ?? {}, parsed.questions ?? {},
    { timeoutMs: flags.timeout ? Number(flags.timeout) : 20_000 })
  if (!out.ok) return emit({ exit: EX.DEGRADED, reason: out.reason, note: out.error }, flags)
  process.stdout.write(JSON.stringify(out.answers, null, 2) + '\n')
  process.stderr.write(`jev raw · ${out.ms}ms · $${out.cost.toFixed(5)} · ${out.missing.length} unanswered\n`)
  writeLog({ cmd: 'raw', cost: out.cost, ms: out.ms, exit: 0 })
  process.exit(EX.OK)
}

async function cmdCheck(flags) {
  const { key, source } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) { process.stderr.write('jev check: no key found\nreason=no-key\n'); process.exit(EX.DEGRADED) }
  const out = await decide(key, { probe: true }, { a: { type: 'noul', instructions: 'This is a test.' } }, { timeoutMs: 15_000 })
  if (!out.ok) { process.stderr.write(`jev check: ${out.reason} — ${out.error}\nreason=${out.reason}\n`); process.exit(EX.DEGRADED) }
  process.stdout.write(`ok · ${(out.ms / 1000).toFixed(2)}s · key=${source} · model=${JEV_MODEL} · spent today $${spentToday().toFixed(4)}\n`)
  process.exit(EX.OK)
}

function cmdStats() {
  if (!existsSync(LOG)) { process.stdout.write('no usage yet\n'); process.exit(EX.OK) }
  const rows = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  if (!rows.length) { process.stdout.write('no usage yet\n'); process.exit(EX.OK) }
  const ms = rows.map((r) => r.ms ?? 0).sort((a, b) => a - b)
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]
  const byExit = {}; for (const r of rows) byExit[r.exit ?? '?'] = (byExit[r.exit ?? '?'] ?? 0) + 1
  const narrow = rows.filter((r) => r.n && r.kept).map((r) => r.kept / r.n)
  const tok = rows.filter((r) => r.inTok && r.estTok)
  process.stdout.write(
    `calls ${rows.length}   cost $${rows.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(4)}   ` +
    `latency p50 ${pct(0.5)}ms p95 ${pct(0.95)}ms\n` +
    `exit codes  ${Object.entries(byExit).map(([k, v]) => `${k}:${v}`).join('  ')}\n` +
    (narrow.length ? `narrowing   median ${(narrow.sort((a, b) => a - b)[narrow.length >> 1] * 100).toFixed(0)}% of candidates kept\n` : '') +
    (tok.length ? `token est   real/estimated ${(tok.reduce((a, r) => a + r.inTok / r.estTok, 0) / tok.length).toFixed(2)}x (tune BYTES_PER_TOKEN if far from 1)\n` : ''),
  )
  process.exit(EX.OK)
}

// ---------------------------------------------------------------- emit

function emit(r, flags = {}) {
  const f = r.flags ?? flags
  if (r.base) writeLog({ ...r.base, exit: r.exit, reason: r.reason ?? null })
  if (f.json) {
    process.stdout.write(JSON.stringify({
      ok: r.exit === EX.OK, complete: r.exit !== EX.PARTIAL, exit: r.exit, reason: r.reason ?? null,
      results: (r.lines ?? []).map((l) => (l.includes('\t') ? { p: Number(l.split('\t')[0]), key: l.split('\t')[1] } : { key: l })),
      ...(r.base ?? {}),
    }) + '\n')
  } else if (r.exit === EX.OK || r.exit === EX.PARTIAL) {
    if (r.lines?.length) process.stdout.write(r.lines.join('\n') + '\n')
  }
  if (r.receipt && !f.quiet && !f.q) process.stderr.write(r.receipt + '\n')
  // Jev cannot say "I don't understand the question"; a flat distribution is the only tell.
  if (r.spread !== undefined && r.spread < 0.15 && !f.quiet)
    process.stderr.write('jev: flat distribution — Jev did not discriminate; rephrase or add --context\n')
  if (r.note) process.stderr.write(`jev: ${r.note}\n`)
  if (r.reason) process.stderr.write(`reason=${r.reason}\n`)
  process.exit(r.exit)
}

// ---------------------------------------------------------------- main

const HELP = `jev — fast judgement calls, for coding agents and shells.

  jev filter <instructions>     candidates on stdin (one per line), the ones that qualify on stdout
  jev ask <question>            stdin is one blob; THE EXIT CODE IS THE ANSWER (0 yes, 1 no)
  jev raw                       stdin {"state":…,"questions":…} straight through; full JSON out
  jev check                     resolve the key and make one trivial call
  jev stats                     what it has cost and how well it has worked

filter flags
  --top N        keep the N best (default 20).  --all  score everything
  --min P        also require probability >= P (opt-in; the defaults are guesses)
  --rank         emit in probability order (default: original stdin order)
  --scores       prefix each line with the probability
  --peek [N]     include the first N lines of each candidate that is a readable file
  --context TEXT shared framing, charged once per chunk; worth more than --peek
  --none-ok      an empty result exits 0 instead of 1
common
  --json  --quiet  --timeout MS  --key K

exit codes
  0 answered, complete      1 answered, and the answer is no      2 usage error
  3 DEGRADED — Jev never saw this (no key, timeout, HTTP, cap). Do it the slow way.
  4 PARTIAL  — some chunks failed; results are a subset of your input.

examples
  git ls-files | jev filter "relevant to adding Stripe webhooks" --top 10
  rg -n TODO src | jev filter "a real blocker, not a nice-to-have" --min 0.7
  npm run build 2>&1 | tail -100 | jev ask "the build succeeded" && echo ok

when NOT to use it
  * if grep can answer it, grep is better — cheaper, exact, never wrong
  * below ~30 candidates, just read them
  * measured: jev LOCATES (a relevant file lands in the top 3-5) but does not ENUMERATE
    (it recovers ~17% of the files a large change touches). A starting point, not the answer.
`

const { flags, rest } = parseArgs(process.argv.slice(2))
const cmd = rest[0]
const arg = rest.slice(1).join(' ')
try {
  if (!cmd || flags.help || cmd === 'help') { process.stdout.write(HELP); process.exit(cmd ? EX.OK : EX.USAGE) }
  else if (cmd === 'filter') await cmdFilter(arg, flags)
  else if (cmd === 'rank') await cmdFilter(arg, { ...flags, rank: true, scores: true })
  else if (cmd === 'ask') await cmdAsk(arg, flags)
  else if (cmd === 'raw') await cmdRaw(flags)
  else if (cmd === 'check') await cmdCheck(flags)
  else if (cmd === 'stats') cmdStats()
  else die(`unknown command "${cmd}" (try: filter, ask, raw, check, stats)`)
} catch (err) {
  // Nothing reaches the user as a stack trace, and a crash is a degraded run, not a wrong answer.
  process.stderr.write(`jev: ${String(err?.message ?? err).slice(0, 200)}\nreason=internal\n`)
  process.exit(EX.DEGRADED)
}
