#!/usr/bin/env node
/**
 * jevlin — fast judgement calls for coding agents.
 *
 * Jev answers many yes/no questions in one round trip and does not write. This CLI wraps
 * that for a shell: candidates on stdin, the ones that matter on stdout, a receipt on
 * stderr, and an exit code the caller can trust.
 *
 * The contract that matters: exit 1 means Jev considered it and said no; exit 3 means Jev
 * never saw it, so do it the slow way. Exit 3 always prints nothing, so a naive
 * `jevlin filter ... | xargs cat` fails loudly rather than quietly working on a truncated world.
 *
 * Measured 2026-09-23 (see SPIKE-RESULTS.md): against a lexical baseline it is ~3x better at
 * putting a relevant file in the top 10. It LOCATES well (small changes: recall@10 0.77,
 * median first hit at rank 3) and ENUMERATES badly (large changes: recall@10 0.17). Treat
 * its output as a starting point, never as the complete set.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveKey, decide, chunkCandidates, est, CHUNK_TOKEN_BUDGET, MAX_Q, JEVLIN_MODEL } from './core.mjs'
import { estimateAgentCost, renderComparison, badge, dim } from './compare.mjs'

const EX = { OK: 0, NO: 1, USAGE: 2, DEGRADED: 3, PARTIAL: 4 }
const LOG = process.env.JEVLIN_LOG || join(homedir(), '.local/state/jevlin/usage.jsonl')
const DAILY_CAP_USD = Number(process.env.JEVLIN_DAILY_CAP ?? 1)
const started = Date.now()

const NO_KEY = `no API key found. jevlin uses OpenRouter — bring your own:
  run:  jevlin init

or set it by hand:
  1. get a key at https://openrouter.ai/keys
  2. export OPENROUTER_API_KEY=sk-or-...        (or put it in ~/.config/jevlin/env)`

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

const die = (msg) => { process.stderr.write(`jevlin: ${msg}\nreason=usage\n`); process.exit(EX.USAGE) }

/**
 * A malformed number must be a usage error, not a silent empty result. `--top abc` used to
 * yield NaN, keep nothing, and exit 1 — which tells the caller "jevlin considered it and said
 * no". Exit 1 has to mean a real judgement or the whole contract is worthless.
 */
function num(flags, name, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (flags[name] === undefined) return undefined
  const raw = flags[name]
  if (raw === true) die(`--${name} needs a value`)
  const v = Number(raw)
  if (!Number.isFinite(v)) die(`--${name} must be a number, got "${raw}"`)
  if (int && !Number.isInteger(v)) die(`--${name} must be a whole number, got "${raw}"`)
  if (v < min || v > max) die(`--${name} must be between ${min} and ${max}, got ${v}`)
  return v
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const bufs = []
  for await (const c of process.stdin) bufs.push(c)
  return Buffer.concat(bufs).toString('utf8')
}

// ---------------------------------------------------------------- log

function writeLog(row) {
  if (process.env.JEVLIN_NO_LOG) return
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
    // An empty key would print as a blank line and, worse, two of them collide into one
    // entry in the score map. A candidate with nothing to echo is not a candidate.
    if (!key.trim()) continue
    out.push({ key, desc: desc.trim() ? desc : key, i: out.length })
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
  if (!instructions) die('filter needs instructions: jevlin filter "what makes a candidate relevant"')
  const minF = num(flags, 'min', { min: 0, max: 1 })
  const topF = num(flags, 'top', { min: 1, int: true })
  const timeoutF = num(flags, 'timeout', { min: 1, int: true })
  const peekF = flags.peek === true ? 20 : num(flags, 'peek', { min: 1, max: 500, int: true })
  const maxCands = num(flags, 'max-candidates', { min: 1, int: true }) ?? 2000

  const raw = await readStdin()
  const cands = parseCandidates(raw, flags)
  if (!cands.length) {
    // "no candidates on stdin" is true but unhelpful: the usual cause is that the command
    // before the pipe produced nothing, and its own error scrolled past a moment earlier.
    die(raw.trim()
      ? 'every line on stdin was blank'
      : 'nothing arrived on stdin — the command before the "|" produced no output.\n' +
        '  If that was `git ls-files`, check you are inside a git repository (cd into your project first).\n' +
        '  Quick check:  git ls-files | head')
  }
  // A stray `find /` would otherwise send a hundred thousand questions and bill for them.
  if (cands.length > maxCands)
    die(`${cands.length} candidates exceeds --max-candidates ${maxCands}; narrow the input first (or raise the flag deliberately)`)

  const { key, source } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) return emit({ exit: EX.DEGRADED, reason: 'no-key', note: NO_KEY }, flags)
  if (spentToday() >= DAILY_CAP_USD)
    return emit({ exit: EX.DEGRADED, reason: 'cap', note: `daily cap $${DAILY_CAP_USD} reached` }, flags)

  const context = [].concat(flags.context ?? [])
  if (typeof flags['context-file'] === 'string') {
    try { context.push(readFileSync(flags['context-file'], 'utf8')) } catch { die(`cannot read ${flags['context-file']}`) }
  }
  const state = { request: instructions, ...(context.length ? { context: context.join('\n') } : {}) }

  const peekLines = peekF ?? 0
  if (peekLines) for (const c of cands) { const p = peekFile(c.key, peekLines); if (p) c.desc = `${c.key} — ${p}` }

  // The state rides with EVERY chunk, so if it alone eats the window the chunker degrades to
  // one candidate per request — 50 calls for 50 candidates, each carrying the whole context.
  // Refuse loudly instead of quietly billing for it.
  const stateTok = est(state)
  const room = CHUNK_TOKEN_BUDGET - stateTok - 200
  const MIN_ROOM = 2_000
  if (room < MIN_ROOM)
    die(`--context is too large (~${stateTok} tokens; the budget is ${CHUNK_TOKEN_BUDGET}). ` +
        `It is sent with every chunk, so a big one multiplies cost. Shorten it to a paragraph.`)
  const chunks = chunkCandidates(cands, (c) => est(c.desc) + 60, { room, maxQ: MAX_Q.noul })
  const timeoutMs = timeoutF ?? 20_000

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

  const hasMin = minF !== undefined
  const min = minF ?? 0
  // Rank cuts, not threshold cuts: a rank survives miscalibration, a threshold does not.
  const top = flags.all ? ranked.length : topF ?? 20
  let kept = ranked.filter(([, v]) => v >= min).slice(0, top)

  const order = new Map(cands.map((c) => [c.key, c.i]))
  if (!flags.rank && !flags.all) kept = kept.slice().sort((a, b) => order.get(a[0]) - order.get(b[0]))

  const elapsed = (Date.now() - started) / 1000
  const head = badge(
    `${cands.length} candidates → ${kept.length} kept · ${chunks.length} chunk${chunks.length > 1 ? 's' : ''}` +
    (hasMin ? ` · min ${min}` : ` · top ${top}`))
  const est2 = process.env.JEVLIN_COMPARE === 'off' || flags.compare === 'off' ? null
    : estimateAgentCost({ n: cands.length, candidateTokens: cands.reduce((a, c) => a + est(c.desc), 0), instructionTokens: est(instructions) })
  const chart = renderComparison({ jevSeconds: elapsed, jevCost: cost, est: est2 })
  const receipt = [head, chart, dim(`  key=${source}`)].filter(Boolean).join('\n')

  const lines = kept.map(([k, v]) => (flags.scores ? `${v.toFixed(2)}\t${k}` : k))
  const base = { cmd: 'filter', n: cands.length, chunks: chunks.length, kept: kept.length, cost, inTok,
    estCost: est2 && !est2.belowBreakEven ? est2.cost : 0,
    estSeconds: est2 && !est2.belowBreakEven ? est2.seconds : 0,
    elapsed,
    estTok: est(state) + cands.reduce((a, c) => a + est(c.desc) + 60, 0), ms, unjudged, inst: instructions.slice(0, 200) }

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
  if (!instructions) die('ask needs a question: jevlin ask "the build succeeded"')
  let blob = await readStdin()
  if (!blob.trim()) die('no text on stdin')
  // Truncate from the middle: the head and tail of a log carry the signal, the middle repeats.
  const CAP = 60_000
  let truncated = false
  if (blob.length > CAP) { blob = blob.slice(0, CAP / 2) + '\n…[truncated]…\n' + blob.slice(-CAP / 2); truncated = true }

  const { key, source } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) return emit({ exit: EX.DEGRADED, reason: 'no-key', note: NO_KEY }, flags)

  const out = await decide(key, { text: blob }, { a: { type: 'noul', instructions } },
    { timeoutMs: num(flags, 'timeout', { min: 1, int: true }) ?? 20_000 })
  if (!out.ok) return emit({ exit: EX.DEGRADED, reason: out.reason, note: out.error }, flags)

  const p = out.answers.a?.noul
  if (typeof p !== 'number') return emit({ exit: EX.DEGRADED, reason: 'parse', note: 'no answer' }, flags)
  const min = num(flags, 'min', { min: 0, max: 1 }) ?? 0.5
  const elapsed = (Date.now() - started) / 1000
  const est2 = process.env.JEVLIN_COMPARE === 'off' || flags.compare === 'off' ? null
    : estimateAgentCost({ n: 1, candidateTokens: est(blob), instructionTokens: est(instructions) })
  const receipt = [
    badge(`${p >= min ? 'YES' : 'no'} · p=${p.toFixed(2)} (min ${min})` + (truncated ? ' · INPUT TRUNCATED' : '')),
    renderComparison({ jevSeconds: elapsed, jevCost: out.cost, est: est2 }),
    dim(`  key=${source}`),
  ].filter(Boolean).join('\n')
  writeLog({ cmd: 'ask', p, min, cost: out.cost, ms: out.ms, elapsed,
    estCost: est2 && !est2.belowBreakEven ? est2.cost : 0,
    estSeconds: est2 && !est2.belowBreakEven ? est2.seconds : 0,
    exit: p >= min ? 0 : 1, inst: instructions.slice(0, 200) })
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    die('stdin must be a JSON object: {"state":…,"questions":…}')
  const qs = parsed.questions ?? {}
  if (typeof qs !== 'object' || Array.isArray(qs)) die('"questions" must be an object keyed by your own ids')
  for (const [id, q] of Object.entries(qs)) {
    if (!q || !['noul', 'choice', 'score'].includes(q.type))
      die(`question "${id}" needs type "noul", "choice" or "score" (got ${JSON.stringify(q?.type)})`)
    if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object'))
      die(`question "${id}" is a choice and needs "criteria": {label: description}`)
    if (q.type === 'score' && !Array.isArray(q.criteria))
      die(`question "${id}" is a score and needs "criteria": [low, …, high]`)
  }
  const { key } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) return emit({ exit: EX.DEGRADED, reason: 'no-key', note: NO_KEY }, flags)
  const out = await decide(key, parsed.state ?? {}, qs,
    { timeoutMs: flags.timeout ? Number(flags.timeout) : 20_000 })
  if (!out.ok) return emit({ exit: EX.DEGRADED, reason: out.reason, note: out.error }, flags)
  process.stdout.write(JSON.stringify(out.answers, null, 2) + '\n')
  process.stderr.write(`jevlin raw · ${out.ms}ms · $${out.cost.toFixed(5)} · ${out.missing.length} unanswered\n`)
  writeLog({ cmd: 'raw', cost: out.cost, ms: out.ms, exit: 0 })
  process.exit(EX.OK)
}

async function cmdCheck(flags) {
  const { key, source } = resolveKey(typeof flags.key === 'string' ? flags.key : undefined)
  if (!key) { process.stderr.write(`jevlin check: ${NO_KEY}\nreason=no-key\n`); process.exit(EX.DEGRADED) }
  const out = await decide(key, { probe: true }, { a: { type: 'noul', instructions: 'This is a test.' } }, { timeoutMs: 15_000 })
  if (!out.ok) { process.stderr.write(`jevlin check: ${out.reason} — ${out.error}\nreason=${out.reason}\n`); process.exit(EX.DEGRADED) }
  process.stdout.write(`ok · ${(out.ms / 1000).toFixed(2)}s · key=${source} · model=${JEVLIN_MODEL} · spent today $${spentToday().toFixed(4)}\n`)
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


// ---------------------------------------------------------------- init

/**
 * Reads a secret without echoing it and without it reaching shell history.
 * Raw mode delivers chunks, not single characters — a paste arrives all at once.
 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return resolve(null)
    process.stdout.write(prompt)
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8')
    let buf = ''
    const done = (val) => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData)
      process.stdout.write('\n'); resolve(val)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf)
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130) }   // ctrl-c
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue } // backspace
        if (ch >= ' ') buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

const ask = (prompt) => new Promise((resolve) => {
  if (!process.stdin.isTTY) return resolve('')
  process.stdout.write(prompt)
  process.stdin.resume(); process.stdin.setEncoding('utf8')
  process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d).trim()) })
})

async function cmdInit() {
  const KEYFILE = join(homedir(), '.config/jevlin/env')
  process.stdout.write('\njevlin needs an OpenRouter API key. It is yours, billed to you —\n')
  process.stdout.write('jevlin never bundles or proxies one.\n\n')

  const existing = resolveKey()
  let needKey = true
  if (existing.key) {
    process.stdout.write(`A key is already being found at: ${existing.source}\n`)
    const a = await ask('Replace it? [y/N] ')
    // Declining must not end setup — someone who set a key months ago and has just
    // installed a new agent still needs the skill step below.
    if (!/^y/i.test(a)) { process.stdout.write('  keeping it.\n'); needKey = false }
  }

  if (needKey && !process.stdin.isTTY) {
    process.stderr.write('jevlin init needs an interactive terminal.\nSet it by hand instead:\n' +
      `  mkdir -p ${dirname(KEYFILE)}\n  echo 'OPENROUTER_API_KEY=sk-or-...' > ${KEYFILE}\n  chmod 600 ${KEYFILE}\n`)
    process.exit(EX.USAGE)
  }

  if (needKey) {
  process.stdout.write('  1. open https://openrouter.ai/keys and create a key\n')
  process.stdout.write('  2. paste it below (it will not be shown, and will not enter your shell history)\n\n')
  const key = await askHidden('  key: ')
  if (!key) { process.stderr.write('\nNothing entered. Nothing written.\n'); process.exit(EX.USAGE) }
  if (!/^sk-or-/.test(key))
    process.stdout.write('\n  note: OpenRouter keys usually start with "sk-or-". Continuing anyway.\n')

  process.stdout.write('\n  checking it works…\n')
  const probe = await decide(key, { probe: true }, { a: { type: 'noul', instructions: 'This is a test.' } }, { timeoutMs: 15_000 })
  if (!probe.ok) {
    process.stderr.write(`\n  that key did not work: ${probe.reason} — ${probe.error ?? ''}\n  Nothing was written.\n`)
    process.exit(EX.DEGRADED)
  }

  // Only written once the key is known to work, and only readable by this user.
  mkdirSync(dirname(KEYFILE), { recursive: true, mode: 0o700 })
  writeFileSync(KEYFILE, `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 })
  process.stdout.write(`  ✓ works (${(probe.ms / 1000).toFixed(2)}s) and saved to ${KEYFILE} (chmod 600)\n`)
  }

  // Offer the agent skill to whichever agents are actually installed.
  const agents = [['Claude Code', join(homedir(), '.claude/skills')], ['Codex', join(homedir(), '.codex/skills')]]
    .filter(([, d]) => existsSync(d))
  if (agents.length) {
    const src = new URL('./skills/jevlin', import.meta.url).pathname
    process.stdout.write(`\n  Found ${agents.map(([n]) => n).join(' and ')}. Install the jevlin skill so they\n  know when to reach for it?\n`)
    const a = await ask('  [Y/n] ')
    if (!/^n/i.test(a)) {
      for (const [name, dir] of agents) {
        try { symlinkSync(src, join(dir, 'jevlin'), 'dir'); process.stdout.write(`  ✓ ${name}\n`) }
        catch (e) { process.stdout.write(`  · ${name}: ${e.code === 'EEXIST' ? 'already installed' : e.message}\n`) }
      }
    }
  }

  if (!agents.length)
    process.stdout.write('\n  No Claude Code or Codex install found (~/.claude/skills, ~/.codex/skills).\n' +
      '  Install one, then run `jevlin init` again to add the skill.\n')
  process.stdout.write('\nReady. Try it, from inside a git repository:\n  git ls-files | jevlin filter "relevant to authentication" --top 10\n\n')
  process.exit(EX.OK)
}

// ---------------------------------------------------------------- emit

function emit(r, flags = {}) {
  const f = r.flags ?? flags
  if (r.base) writeLog({ ...r.base, exit: r.exit, reason: r.reason ?? null })
  if (f.json) {
    process.stdout.write(JSON.stringify({
      // `complete` means "every candidate was judged" — false on a degraded run (nothing was
      // judged) as well as on a partial one. Only exit 0 and a clean "no" are complete.
      ok: r.exit === EX.OK, complete: r.exit === EX.OK || r.exit === EX.NO, exit: r.exit, reason: r.reason ?? null,
      results: (r.lines ?? []).map((l) => (l.includes('\t') ? { p: Number(l.split('\t')[0]), key: l.split('\t')[1] } : { key: l })),
      ...(r.base ?? {}),
    }) + '\n')
  } else if (r.exit === EX.OK || r.exit === EX.PARTIAL) {
    if (r.lines?.length) process.stdout.write(r.lines.join('\n') + '\n')
  }
  if (r.receipt && !f.quiet && !f.q) process.stderr.write(r.receipt + '\n')
  // Jev cannot say "I don't understand the question"; a flat distribution is the only tell.
  if (r.spread !== undefined && r.spread < 0.15 && !f.quiet)
    process.stderr.write('jevlin: flat distribution — Jev did not discriminate; rephrase or add --context\n')
  if (r.note) process.stderr.write(`jevlin: ${r.note}\n`)
  if (r.reason) process.stderr.write(`reason=${r.reason}\n`)
  process.exit(r.exit)
}

// ---------------------------------------------------------------- main

const HELP = `jevlin — fast judgement calls, for coding agents and shells.

  jevlin filter <instructions>     candidates on stdin (one per line), the ones that qualify on stdout
  jevlin ask <question>            stdin is one blob; THE EXIT CODE IS THE ANSWER (0 yes, 1 no)
  jevlin raw                       stdin {"state":…,"questions":…} straight through; full JSON out
  jevlin init                      set up your API key, and the agent skill
  jevlin check                     resolve the key and make one trivial call
  jevlin stats                     what it has cost and how well it has worked

filter flags
  --top N        keep the N best (default 20).  --all  score everything
  --max-candidates N   refuse more than N lines of input (default 2000)
  --min P        also require probability >= P (opt-in; the defaults are guesses)
  --rank         emit in probability order (default: original stdin order)
  --scores       prefix each line with the probability
  --peek [N]     include the first N lines of each candidate that is a readable file
  --context TEXT shared framing, charged once per chunk; worth more than --peek
  --none-ok      an empty result exits 0 instead of 1
common
  --json  --quiet  --timeout MS  --key K
  --compare off  hide the "what this would have cost your main model" comparison

the comparison
  The input side is measured (jevlin's real token usage, and the candidate text itself).
  The output side is an ASSUMPTION about how much your model would think — ~12 tokens
  per candidate at ~55 tok/s. Tune with JEVLIN_COMPARE_OUTPUT_TOKENS and JEVLIN_COMPARE_TPS,
  pick the model with JEVLIN_COMPARE_MODEL, or turn it off with JEVLIN_COMPARE=off.
  Everything estimated is marked with ~.

exit codes
  0 answered, complete      1 answered, and the answer is no      2 usage error
  3 DEGRADED — Jev never saw this (no key, timeout, HTTP, cap). Do it the slow way.
  4 PARTIAL  — some chunks failed; results are a subset of your input.

examples
  git ls-files | jevlin filter "relevant to adding Stripe webhooks" --top 10
  rg -n TODO src | jevlin filter "a real blocker, not a nice-to-have" --min 0.7
  npm run build 2>&1 | tail -100 | jevlin ask "the build succeeded" && echo ok

when NOT to use it
  * if grep can answer it, grep is better — cheaper, exact, never wrong
  * below ~30 candidates, just read them
  * measured: jevlin LOCATES (a relevant file lands in the top 3-5) but does not ENUMERATE
    (it recovers ~17% of the files a large change touches). A starting point, not the answer.
`

const KNOWN = {
  common: ['json', 'quiet', 'q', 'timeout', 'key', 'help', 'compare'],
  filter: ['min', 'top', 'all', 'rank', 'scores', 'peek', 'context', 'context-file', 'none-ok', 'max-candidates', 'concurrency', 'sep'],
  ask: ['min', 'p'],
  raw: [], check: [], stats: [], init: [],
}

const { flags, rest } = parseArgs(process.argv.slice(2))
const cmd = rest[0]
const arg = rest.slice(1).join(' ')
try {
  if (!cmd || flags.help || cmd === 'help') { process.stdout.write(HELP); process.exit(cmd ? EX.OK : EX.USAGE) }
  // A typo like `--tpo 5` must not be silently ignored: the caller would get 20 results and
  // believe it asked for 5.
  const allowed = new Set([...KNOWN.common, ...(KNOWN[cmd === 'rank' ? 'filter' : cmd] ?? [])])
  const unknown = Object.keys(flags).filter((f) => !allowed.has(f))
  if (unknown.length) die(`unknown flag${unknown.length > 1 ? 's' : ''} for "${cmd}": ${unknown.map((f) => '--' + f).join(', ')}`)
  else if (cmd === 'filter') await cmdFilter(arg, flags)
  else if (cmd === 'rank') await cmdFilter(arg, { ...flags, rank: true, scores: true })
  else if (cmd === 'ask') await cmdAsk(arg, flags)
  else if (cmd === 'raw') await cmdRaw(flags)
  else if (cmd === 'init') await cmdInit()
  else if (cmd === 'check') await cmdCheck(flags)
  else if (cmd === 'stats') cmdStats()
  else die(`unknown command "${cmd}" (try: init, filter, ask, raw, check, stats)`)
} catch (err) {
  // Nothing reaches the user as a stack trace, and a crash is a degraded run, not a wrong answer.
  process.stderr.write(`jevlin: ${String(err?.message ?? err).slice(0, 200)}\nreason=internal\n`)
  process.exit(EX.DEGRADED)
}
