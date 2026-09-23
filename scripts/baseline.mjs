/**
 * The control for the spike: score each file path by plain lexical overlap with the task,
 * no model, no network. If this matches Jev, Jev is a placebo and `grep` already wins.
 * Same tasks, same gold sets, same metrics as spike.mjs.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const git = (repo, args) =>
  execFileSync('git', ['-C', join(homedir(), repo), ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').map((s) => s.trim()).filter(Boolean)

const STOP = new Set('the a an and or of to in on for with is are be it its this that they them her his she he i you we can not no only just into at as by from every their our all more most one two new now back again over under above'.split(' '))
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))
/** Split paths on separators AND camelCase, so `TldrawDurableObject.ts` yields tldraw/durable/object. */
const pathWords = (p) => words(p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[\/._-]/g, ' '))

function score(task, files) {
  const q = words(task)
  const df = new Map()
  const toks = files.map((f) => { const t = new Set(pathWords(f)); for (const w of t) df.set(w, (df.get(w) ?? 0) + 1); return t })
  const N = files.length
  return files
    .map((f, i) => {
      let s = 0
      for (const w of q) if (toks[i].has(w)) s += Math.log(1 + N / (df.get(w) ?? N))   // idf-weighted overlap
      return [f, s]
    })
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
}

const recallAt = (r, g, k) => r.slice(0, k).filter((p) => g.has(p)).length / g.size
const precAt = (r, g, k) => r.slice(0, k).filter((p) => g.has(p)).length / k
const firstRank = (r, g) => { const i = r.findIndex((p) => g.has(p)); return i < 0 ? null : i + 1 }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

const tasks = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'))
const rows = []
for (const t of tasks) {
  const before = new Set(git(t.repo, ['ls-tree', '-r', '--name-only', `${t.sha}^`]))
  const gold = new Set(git(t.repo, ['show', '--name-only', '--format=', t.sha]).filter((f) => before.has(f)))
  if (!gold.size) continue
  const files = [...before]
  for (const variant of ['posthoc', 'rephrased']) {
    const text = t[variant]; if (!text) continue
    const ranked = score(text, files)
    rows.push({ repo: t.repo, variant, gold: gold.size, rank1: firstRank(ranked, gold),
      r5: recallAt(ranked, gold, 5), r10: recallAt(ranked, gold, 10), r20: recallAt(ranked, gold, 20),
      p10: precAt(ranked, gold, 10) })
  }
}
const sum = (label, sel) => {
  const g = rows.filter(sel); if (!g.length) return
  const small = g.filter((r) => r.gold <= 3), big = g.filter((r) => r.gold >= 6)
  console.log(`\n### BASELINE ${label} (${g.length} runs)`)
  console.log(`  MRR                ${mean(g.map((r) => (r.rank1 ? 1 / r.rank1 : 0))).toFixed(3)}`)
  console.log(`  recall@5 / @10 / @20   ${mean(g.map((r) => r.r5)).toFixed(2)} / ${mean(g.map((r) => r.r10)).toFixed(2)} / ${mean(g.map((r) => r.r20)).toFixed(2)}`)
  if (small.length) console.log(`  small (gold<=3), n=${small.length}: recall@5 ${mean(small.map((r) => r.r5)).toFixed(2)}  recall@10 ${mean(small.map((r) => r.r10)).toFixed(2)}`)
  if (big.length) console.log(`  big   (gold>=6), n=${big.length}: precision@10 ${mean(big.map((r) => r.p10)).toFixed(2)}  recall@10 ${mean(big.map((r) => r.r10)).toFixed(2)}  recall@20 ${mean(big.map((r) => r.r20)).toFixed(2)}`)
}
sum('ALL', () => true)
sum('POST-HOC', (r) => r.variant === 'posthoc')
sum('HAND-REPHRASED', (r) => r.variant === 'rephrased')
