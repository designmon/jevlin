/**
 * Adversarial tests. Everything here is offline except where marked LIVE, so it is cheap
 * to run often. Properties first: the chunker and the parser are where silent corruption
 * would hide, because a wrong answer looks exactly like a right one.
 */
import { chunkCandidates, est, redact, readAnswers } from '../core.mjs'

let fail = 0
const ok = (name, cond, detail = '') => { if (cond) console.log(`ok    ${name}`); else { fail++; console.log(`FAIL  ${name}  ${detail}`) } }

// ---- chunker properties -----------------------------------------------------
const rnd = (n, max) => Array.from({ length: n }, (_, i) => ({ i, w: 1 + Math.floor(Math.random() * max) }))
for (const [n, maxW, room, maxQ] of [[1, 5, 100, 10], [7, 5, 100, 10], [1000, 5, 100, 10], [500, 90, 100, 50], [150, 1, 10_000, 150], [3, 200, 100, 10]]) {
  const items = rnd(n, maxW)
  const chunks = chunkCandidates(items, (c) => c.w, { room, maxQ })
  const flat = chunks.flat()
  ok(`chunker keeps every item (n=${n},room=${room},maxQ=${maxQ})`, flat.length === n, `got ${flat.length}`)
  ok(`chunker preserves order (n=${n})`, flat.every((c, k) => c.i === k))
  ok(`chunker never exceeds maxQ (n=${n})`, chunks.every((c) => c.length <= maxQ), `max ${Math.max(...chunks.map((c) => c.length))}`)
  const over = chunks.filter((c) => c.length > 1 && c.reduce((a, x) => a + x.w, 0) > room)
  ok(`chunker respects room unless an item alone exceeds it (n=${n})`, over.length === 0, `${over.length} chunks over`)
}
// an item bigger than the whole room must still be emitted, alone, not dropped
{
  const items = [{ i: 0, w: 1 }, { i: 1, w: 9999 }, { i: 2, w: 1 }]
  const chunks = chunkCandidates(items, (c) => c.w, { room: 100, maxQ: 10 })
  ok('chunker emits an oversized item rather than dropping it', chunks.flat().length === 3)
}
ok('chunker handles an empty list', chunkCandidates([], () => 1, { room: 10, maxQ: 5 }).flat().length === 0)

// ---- est() ------------------------------------------------------------------
ok('est handles empty string', est('') === 0)
ok('est handles multibyte', est('日本語テキスト') > 0)
ok('est of an object is finite', Number.isFinite(est({ a: 'x'.repeat(1000) })))

// ---- readAnswers: must drop bad answers individually, never throw ------------
const qs = { a: { type: 'noul', instructions: 'x' }, b: { type: 'choice', instructions: 'x', criteria: { p: 'P', q: 'Q' } }, c: { type: 'score', instructions: 'x', criteria: ['lo', 'hi'] } }
ok('readAnswers drops an out-of-range noul', !('a' in readAnswers({ a: { noul: 1.7 } }, qs)))
ok('readAnswers drops a label that was not offered', !('b' in readAnswers({ b: { choice: 'zzz' } }, qs)))
ok('readAnswers drops an off-scale score', !('c' in readAnswers({ c: { score: 99 } }, qs)))
ok('readAnswers ignores an id nobody asked about', Object.keys(readAnswers({ nope: { noul: 0.5 } }, qs)).length === 0)
ok('readAnswers keeps the good ones beside the bad', readAnswers({ a: { noul: 0.4 }, b: { choice: 'zzz' } }, qs).a?.noul === 0.4)
ok('readAnswers survives null', readAnswers(null, qs) === null)
ok('readAnswers survives a non-object answer', Object.keys(readAnswers({ a: 'hello' }, qs)).length === 0)
ok('readAnswers survives an array', Object.keys(readAnswers([1, 2, 3], qs)).length === 0)

// ---- redactor: adversarial ---------------------------------------------------
const mustHide = [
  'Authorization: Bearer sk-ant-PLACEHOLDER_not_a_real_key',
  'export STRIPE_SECRET_KEY=rk_PLACEHOLDER_not_a_real_key',
  '{"client_secret":"GOCSPX_PLACEHOLDER_not_a_real"}',
  'mysql://root:SuperSecret123@10.0.0.1/db',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDZ1234567890abcdefghijklmnop user@host',
]
for (const s of mustHide) {
  const { text, redactions } = redact(s)
  ok(`redacts: ${s.slice(0, 34)}…`, redactions > 0 && !/[A-Za-z0-9_-]{26,}/.test(text), text.slice(0, 70))
}
const keepers = ['const veryLongDescriptiveFunctionName = () => 1', 'import { somethingRatherLong } from "./module"', 'https://example.com/docs/getting-started/installation']
for (const s of keepers) ok(`leaves ordinary code alone: ${s.slice(0, 30)}…`, redact(s).text === s, redact(s).text)
ok('redact returns the same shape for empty', redact('').text === '' && redact('').redactions === 0)
ok('redact returns the same shape for undefined', redact(undefined).text === '' && redact(undefined).redactions === 0)

// ---- comparison module ------------------------------------------------------
{
  const { estimateAgentCost, renderComparison, compareModel } = await import('../compare.mjs')
  const m = compareModel()
  ok('compareModel resolves to a priced model', m === null || (m.id && m.price?.length === 2), JSON.stringify(m))

  process.env.JEV_COMPARE_MODEL = 'claude-opus-5'
  const e = estimateAgentCost({ n: 200, candidateTokens: 4000, instructionTokens: 20 })
  ok('estimate is finite and positive', e.cost > 0 && Number.isFinite(e.cost) && e.seconds > 0)
  ok('a bigger candidate set costs more',
    estimateAgentCost({ n: 500, candidateTokens: 9000 }).cost > estimateAgentCost({ n: 50, candidateTokens: 900 }).cost)
  ok('output tokens are clamped', estimateAgentCost({ n: 100000, candidateTokens: 10 }).outTok <= 6000)
  ok('a cheaper model estimates cheaper', (() => {
    process.env.JEV_COMPARE_MODEL = 'claude-haiku-4-5'
    const cheap = estimateAgentCost({ n: 200, candidateTokens: 4000 }).cost
    process.env.JEV_COMPARE_MODEL = 'claude-opus-5'
    return cheap < estimateAgentCost({ n: 200, candidateTokens: 4000 }).cost
  })())
  process.env.JEV_COMPARE_MODEL = 'not-a-real-model'
  ok('an unknown comparison model degrades to no comparison', estimateAgentCost({ n: 10, candidateTokens: 10 }) === null)
  process.env.JEV_COMPARE_MODEL = 'claude-opus-5'

  // The tool must not claim a win on a run its own guidance says not to make.
  ok('below break-even there is no ratio claim', (() => {
    const e = estimateAgentCost({ n: 5, candidateTokens: 50 })
    if (!e?.belowBreakEven) return false
    const out = renderComparison({ jevSeconds: 1, jevCost: 0.00001, est: e })
    return !/cheaper|faster/.test(out) && /reading them directly/.test(out)
  })())
  ok('at and above break-even the comparison returns', !estimateAgentCost({ n: 30, candidateTokens: 600 })?.belowBreakEven)

  ok('renderComparison returns nothing without an estimate', renderComparison({ jevSeconds: 1, jevCost: 1, est: null }) === '')
  const chart = renderComparison({ jevSeconds: 1.4, jevCost: 0.0002, est: estimateAgentCost({ n: 200, candidateTokens: 4000 }) })
  ok('chart has two rows', chart.split('\n').length === 2, JSON.stringify(chart))
  ok('chart never prints exponent notation', !/e[-+]\d/.test(chart), chart)
  // a zero-cost run (cache or mock) must not produce Infinity or NaN in the ratio
  const z = renderComparison({ jevSeconds: 0.01, jevCost: 0, est: estimateAgentCost({ n: 10, candidateTokens: 100 }) })
  ok('zero jev cost does not render Infinity/NaN', !/Infinity|NaN/.test(z), z)
}

console.log(fail ? `\n${fail} FAILURES` : '\nall property tests pass')
process.exit(fail ? 1 : 0)
