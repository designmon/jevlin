import { redact } from '../core.mjs'
const cases = [
  ['OPENROUTER_API_KEY=sk-or-PLACEHOLDER_not_a_real_key', 'sk-or'],
  ['const token = "ghp_PLACEHOLDER_not_a_real_key"', 'ghp_'],
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalr'],
  ['aws_key: AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['curl -H \'Authorization: Bearer abc123def456ghi789\' https://x', 'abc123def456'],
  ['DATABASE_URL=postgres://admin:hunter2@db.example.com:5432/app', 'hunter2'],
  ['jwt = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJhbGci'],
  ['GEMINI_API_KEY=AIza_PLACEHOLDER_not_a_real_key', 'AIzaSy'],
  ['"password": "correct-horse-battery"', 'correct-horse'],
]
let fail = 0
for (const [input, leak] of cases) {
  const { text, redactions } = redact(input)
  const leaked = text.includes(leak)
  if (leaked || redactions === 0) { fail++; console.log('FAIL', JSON.stringify(input), '->', text) }
  else console.log('ok  ', text)
}
// must not shred ordinary code
const benign = 'function computeTotalOrderValue(items) { return items.length * 42 }'
const b = redact(benign)
if (b.text !== benign) { fail++; console.log('FAIL benign code was altered ->', b.text) }
else console.log('ok   benign code untouched')
console.log(fail ? `\n${fail} FAILURES` : '\nall redaction tests pass')
process.exit(fail ? 1 : 0)
