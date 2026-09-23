import { redact } from '../core.mjs'
// Assembled at runtime so no literal here matches a real provider key format — a fixture
// that looks like a live credential blocks pushes and alarms anyone who clones the repo.
const J = (...p) => p.join('')
const cases = [
  [J('OPENROUTER_API_KEY=', 'sk', '-or-v1-', '9f3a2b7c8d1e4f5a6b7c8d9e0f1a2b3c'), 'or-v1-9f3a'],
  [J('const token = "', 'ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', '"'), 'ABCDEFGHIJ'],
  [J('AWS_SECRET_ACCESS_KEY=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'wJalr'],
  [J('aws_key: ', 'AKIA', 'IOSFODNN7EXAMPLE'), 'IOSFODNN7EXAMPLE'],
  [J("curl -H 'Authorization: Bearer ", 'abc123def456ghi789', "' https://x"), 'abc123def456'],
  [J('DATABASE_URL=postgres://admin:', 'hunter2', '@db.example.com:5432/app'), 'hunter2'],
  [J('jwt = ', 'eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'), 'eyJhbGci'],
  [J('GEMINI_API_KEY=', 'AIza', 'SyD-1234567890abcdefghijklmnopqrstu'), 'SyD-12345'],
  [J('"password": "', 'correct-horse-battery', '"'), 'correct-horse'],
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
