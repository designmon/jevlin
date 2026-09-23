/**
 * A stand-in Jev, so the CLI can be tested end to end without a key or a network.
 * Scores each candidate by whether it contains any word given in JEV_MOCK_MATCH.
 * JEV_MOCK_FAIL_AFTER=N makes every request after the Nth hang, to exercise partial failure.
 */
import { createServer } from 'node:http'
const MATCH = (process.env.JEV_MOCK_MATCH ?? 'even').split(',')
const FAIL_AFTER = Number(process.env.JEV_MOCK_FAIL_AFTER ?? Infinity)
let n = 0
createServer((req, res) => {
  let b = ''
  req.on('data', (d) => (b += d))
  req.on('end', () => {
    if (++n > FAIL_AFTER) return                        // hang; the client aborts
    const { questions, state } = JSON.parse(b)
    const answers = {}
    for (const [k, q] of Object.entries(questions)) {
      // `filter` puts the candidate after "qualify: "; `ask` has no candidate, so the blob
      // in state.text is what is being judged.
      const inst = String(q.instructions)
      const cand = inst.includes('qualify: ') ? inst.split('qualify: ').pop() : String(state?.text ?? inst)
      const num = Number(cand)
      const hit = MATCH.includes('even') && Number.isFinite(num) ? num % 2 === 0
        : MATCH.some((w) => w !== 'even' && cand.toLowerCase().includes(w))
      answers[k] = { noul: hit ? 0.95 : 0.05 }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ answers, usage: { input_tokens: 50, output_tokens: 3, cost: 0.000005 } }))
  })
}).listen(Number(process.env.JEV_MOCK_PORT ?? 8896), () => process.stderr.write('mock ready\n'))
