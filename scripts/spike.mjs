/**
 * Phase 0: does Jev actually pick the right files from a task description?
 *
 * Ground truth from git: a commit's message is the task, the files it changed are the
 * answer. Candidates are the files that existed *before* the commit, and the gold set is
 * the pre-existing files it changed — asking "which file must change" is answerable;
 * asking it to name a file that does not exist yet is not.
 *
 * Half the tasks carry a hand-rephrased variant, written from the message alone without
 * looking at the diff, because a commit message is written after the work and tends to
 * name the very concepts in the filenames. The rephrased half is the honest number.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveKey, decide, chunkCandidates, est, CHUNK_TOKEN_BUDGET, MAX_Q } from '../core.mjs'

const git = (repo, args) =>
  execFileSync('git', ['-C', join(homedir(), repo), ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').map((s) => s.trim()).filter(Boolean)

const CONTEXT = {
  'figle-app': 'A Next.js + React party game. UI components, game screens and API routes; AI image generation via Gemini; marketing pages alongside the app.',
  'boardroom-jev': 'A Cloudflare Worker + tldraw canvas where four AI teammates work in rounds. Worker code holds the durable object, model clients and decision policy; client code holds the canvas UI.',
}

async function rankFiles(key, task, files, { withContext }) {
  const state = withContext
    ? { request: task, repository: CONTEXT[withContext] }
    : { request: task }
  const room = CHUNK_TOKEN_BUDGET - est(state) - 200
  const chunks = chunkCandidates(
    files.map((path, i) => ({ path, i })),
    (c) => est(c.path) + 28,
    { room, maxQ: MAX_Q.noul },
  )

  const scores = new Map()
  let ms = 0, cost = 0, missing = 0
  const outs = await Promise.all(
    chunks.map((items) => {
      const questions = Object.fromEntries(
        items.map((c) => [`f${c.i}`, {
          type: 'noul',
          instructions: `Doing the work in the request would require editing this file: ${c.path}`,
        }]),
      )
      return decide(key, state, questions, { timeoutMs: 20_000 }).then((o) => [o, items])
    }),
  )
  for (const [o, items] of outs) {
    if (!o.ok) return { ok: false, reason: o.reason, error: o.error }
    ms = Math.max(ms, o.ms); cost += o.cost; missing += o.missing.length
    for (const c of items) {
      const a = o.answers[`f${c.i}`]
      // A missing answer is not a negative judgement: keep it, at the neutral midpoint.
      scores.set(c.path, a ? a.noul : 0.5)
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
  const vals = [...scores.values()].sort((a, b) => a - b)
  const q = (f) => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))]
  return { ok: true, ranked, ms, cost, missing, chunks: chunks.length, spread: q(0.95) - q(0.05) }
}

const recallAt = (ranked, gold, k) => ranked.slice(0, k).filter((p) => gold.has(p)).length / gold.size
const precAt = (ranked, gold, k) => ranked.slice(0, k).filter((p) => gold.has(p)).length / k
const firstRank = (ranked, gold) => { const i = ranked.findIndex((p) => gold.has(p)); return i < 0 ? null : i + 1 }

const { key, source } = resolveKey()
if (!key) { console.error('no key found'); process.exit(3) }
console.error(`key from ${source}\n`)

const mode = process.argv[2] ?? 'both'          // posthoc | rephrased | both
const useContext = process.argv.includes('--context')
const tasks = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'))
const rows = []

for (const t of tasks) {
  const before = new Set(git(t.repo, ['ls-tree', '-r', '--name-only', `${t.sha}^`]))
  const changed = git(t.repo, ['show', '--name-only', '--format=', t.sha])
  const gold = new Set(changed.filter((f) => before.has(f)))
  if (!gold.size) { console.error(`skip ${t.sha} (all files were new)`); continue }
  const files = [...before]

  for (const variant of ['posthoc', 'rephrased']) {
    if (mode !== 'both' && mode !== variant) continue
    const text = t[variant]
    if (!text) continue
    const r = await rankFiles(key, text, files, { withContext: useContext ? t.repo : null })
    if (!r.ok) { console.error(`FAIL ${t.sha} ${variant}: ${r.reason} ${r.error ?? ''}`); continue }
    rows.push({
      repo: t.repo, sha: t.sha, variant, n: files.length, gold: gold.size,
      rank1: firstRank(r.ranked, gold),
      r5: recallAt(r.ranked, gold, 5), r10: recallAt(r.ranked, gold, 10), r20: recallAt(r.ranked, gold, 20),
      p10: precAt(r.ranked, gold, 10), p20: precAt(r.ranked, gold, 20),
      ms: r.ms, cost: r.cost, chunks: r.chunks, missing: r.missing, spread: r.spread,
      top3: r.ranked.slice(0, 3),
    })
    const row = rows.at(-1)
    console.error(
      `${t.sha} ${variant.padEnd(9)} n=${String(files.length).padStart(3)} gold=${String(gold.size).padStart(2)} ` +
      `rank1=${String(row.rank1 ?? '-').padStart(3)} r@10=${row.r10.toFixed(2)} ` +
      `spread=${row.spread.toFixed(2)} ${row.ms}ms $${row.cost.toFixed(5)}`,
    )
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const summarise = (label, sel) => {
  const g = rows.filter(sel); if (!g.length) return
  const small = g.filter((r) => r.gold <= 3), big = g.filter((r) => r.gold >= 6)
  console.log(`\n### ${label}  (${g.length} runs)`)
  console.log(`  MRR                ${mean(g.map((r) => (r.rank1 ? 1 / r.rank1 : 0))).toFixed(3)}`)
  console.log(`  recall@5 / @10 / @20   ${mean(g.map((r) => r.r5)).toFixed(2)} / ${mean(g.map((r) => r.r10)).toFixed(2)} / ${mean(g.map((r) => r.r20)).toFixed(2)}`)
  if (small.length) console.log(`  small (gold<=3), n=${small.length}: recall@5 ${mean(small.map((r) => r.r5)).toFixed(2)}  recall@10 ${mean(small.map((r) => r.r10)).toFixed(2)}  median rank of first hit ${[...small.map((r) => r.rank1 ?? 999)].sort((a, b) => a - b)[Math.floor(small.length / 2)]}`)
  if (big.length) console.log(`  big   (gold>=6), n=${big.length}: precision@10 ${mean(big.map((r) => r.p10)).toFixed(2)}  recall@10 ${mean(big.map((r) => r.r10)).toFixed(2)}  recall@20 ${mean(big.map((r) => r.r20)).toFixed(2)}`)
  console.log(`  flat distributions (spread<0.15)  ${g.filter((r) => r.spread < 0.15).length}/${g.length}`)
  console.log(`  latency  mean ${Math.round(mean(g.map((r) => r.ms)))}ms   cost total $${g.reduce((a, r) => a + r.cost, 0).toFixed(4)}   unanswered ${g.reduce((a, r) => a + r.missing, 0)}`)
}

summarise('ALL', () => true)
summarise('POST-HOC phrasing (flattering)', (r) => r.variant === 'posthoc')
summarise('HAND-REPHRASED (the honest number)', (r) => r.variant === 'rephrased')
summarise('figle-app', (r) => r.repo === 'figle-app')
summarise('boardroom-jev', (r) => r.repo === 'boardroom-jev')
console.log('\nrows:', JSON.stringify(rows.map(({ top3, ...r }) => r)).length, 'bytes of detail withheld; rerun with --dump for top3')
if (process.argv.includes('--dump')) for (const r of rows) console.log(r.sha, r.variant, '->', r.top3.join('  '))
