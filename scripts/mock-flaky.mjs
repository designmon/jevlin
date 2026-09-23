/** A Jev that answers the first request and then times out, so exit code 4 can be exercised. */
import { createServer } from 'node:http'
let n = 0
createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (n++ > 0) return                       // hang: the client's AbortSignal fires
    const { questions } = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.9 }])),
      usage: { input_tokens: 10, output_tokens: 1, cost: 0.000001 },
    }))
  })
}).listen(8899, () => console.error('mock on 8899'))
