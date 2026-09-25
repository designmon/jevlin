/**
 * Measure jevlin against YOUR work, not against a benchmark someone else designed.
 *
 * Input: a JSON array of { repo, task, gold } where `repo` is a path to a git checkout,
 * `task` is the request as you would actually phrase it, and `gold` is the list of
 * repo-relative files that turned out to matter.
 *
 *   node scripts/bench-tasks.mjs my-tasks.json
 *
 * Build that file from whatever ground truth you have — commits, tickets, or your own agent
 * history. Two warnings learned the hard way, both visible in SPIKE-RESULTS.md:
 *   - Queries written AFTER the work (commit messages) overstate the result ~4x, because
 *     they name the concepts that are already in the filenames.
 *   - Report recall AND "did it surface anything useful at all", because with a large gold
 *     set you clip a file by chance and the headline number flatters you.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveKey, decide, chunkCandidates, est, CHUNK_TOKEN_BUDGET, MAX_Q } from '../core.mjs'

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/bench-tasks.mjs <tasks.json>'); process.exit(2) }
const tasks = JSON.parse(readFileSync(file, 'utf8'))
const { key } = resolveKey()
if (!key) { console.error('no API key — run `jevlin init`'); process.exit(3) }

const cache = {}
const listing = (repo) => (cache[repo] ??= existsSync(join(repo, '.git'))
  ? execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean)
  : null)

async function rank(task, list) {
  const state = { request: task }
  const chunks = chunkCandidates(list.map((p, i) => ({ p, i })), (c) => est(c.p) + 60,
    { room: CHUNK_TOKEN_BUDGET - est(state) - 200, maxQ: MAX_Q.noul })
  const scores = new Map()
  let cost = 0
  for (const [o, items] of await Promise.all(chunks.map((items) =>
    decide(key, state, Object.fromEntries(items.map((c) =>
      [`f${c.i}`, { type: 'noul', instructions: `${task}\n\nDoing this work would require editing this file: ${c.p}` }])),
      { timeoutMs: 25_000 }).then((o) => [o, items])))) {
    if (!o.ok) return null
    cost += o.cost
    for (const c of items) scores.set(c.p, o.answers[`f${c.i}`]?.noul ?? 0.5)   // unjudged is not a no
  }
  return { ranked: [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p), cost }
}

const rows = []
let spend = 0
for (const t of tasks) {
  const list = listing(t.repo)
  if (!list) { console.error(`skip: ${t.repo} is not a git checkout`); continue }
  const present = new Set(list)
  const gold = new Set((t.gold ?? []).filter((g) => present.has(g)))
  if (!gold.size) continue
  const r = await rank(t.task, list)
  if (!r) { console.error(`skip: jevlin failed on "${t.task}"`); continue }
  spend += r.cost
  const at = (k) => r.ranked.slice(0, k).filter((p) => gold.has(p)).length
  const first = r.ranked.findIndex((p) => gold.has(p))
  rows.push({ gold: gold.size, r5: at(5) / gold.size, r10: at(10) / gold.size, r20: at(20) / gold.size,
    p10: at(10) / 10, rank1: first < 0 ? null : first + 1 })
  process.stderr.write('.')
}
process.stderr.write('\n')
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const show = (label, sel) => {
  const g = rows.filter(sel); if (!g.length) return
  console.log(`\n### ${label}  (${g.length} tasks)`)
  console.log(`  recall@5 / @10 / @20                  ${mean(g.map((r) => r.r5)).toFixed(2)} / ${mean(g.map((r) => r.r10)).toFixed(2)} / ${mean(g.map((r) => r.r20)).toFixed(2)}`)
  console.log(`  precision@10                          ${mean(g.map((r) => r.p10)).toFixed(2)}`)
  console.log(`  at least one correct file in top 10   ${(100 * g.filter((r) => r.rank1 && r.rank1 <= 10).length / g.length).toFixed(0)}%`)
  console.log(`  median rank of the first correct file ${[...g.map((r) => r.rank1 ?? 9999)].sort((a, b) => a - b)[g.length >> 1]}`)
}
show('ALL', () => true)
show('small (<=3 files)', (r) => r.gold <= 3)
show('enumeration (>=6 files)', (r) => r.gold >= 6)
console.log(`\ncost: $${spend.toFixed(4)}`)
console.log('For reference, the numbers this scored on real work: recall@10 0.15, one-useful-hit 58%.')
