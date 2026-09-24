/**
 * Runs each hook as a real process with realistic stdin.
 *
 * Exists because `node --check` happily passed a hook whose STATE_DIR import was missing —
 * a syntax check cannot catch an unresolved binding, and the hook silently wrote nothing.
 * A hook that is never executed in CI is a hook that is broken and nobody notices.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from '../core.mjs'

let fail = 0
const ok = (n, c, d = '') => { if (c) console.log(`ok    ${n}`); else { fail++; console.log(`FAIL  ${n}  ${d}`) } }
const SID = 'hooktest-' + process.pid
const run = (hook, payload, env = {}) => {
  try {
    const out = execFileSync(process.execPath, [new URL(`../hooks/${hook}`, import.meta.url).pathname],
      { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } })
    return { ok: true, out }
  } catch (e) { return { ok: false, out: String(e.stderr ?? e.message) } }
}

// remember.mjs must cache the prompt, in the directory the CLI also uses
const r1 = run('remember.mjs', { session_id: SID, prompt: 'fix the failing test' })
ok('remember.mjs exits 0', r1.ok, r1.out.slice(0, 200))
const promptFile = join(STATE_DIR, `prompt-${SID}.json`)
ok('remember.mjs writes into the shared STATE_DIR', existsSync(promptFile), `expected ${promptFile}`)
if (existsSync(promptFile))
  ok('the cached prompt is the one it was given', JSON.parse(readFileSync(promptFile, 'utf8')).prompt === 'fix the failing test')

// surface.mjs must never crash, and must stay silent on an unrelated tool call
const r2 = run('surface.mjs', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_output: {} })
ok('surface.mjs exits 0 on an unrelated command', r2.ok, r2.out.slice(0, 200))
ok('surface.mjs stays silent on an unrelated command', r2.out.trim() === '', r2.out.slice(0, 120))

// and must emit a systemMessage — the only channel that reaches the user — for a jevlin call
const r3 = run('surface.mjs', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'git ls-files | jevlin filter x' }, tool_output: {} })
ok('surface.mjs exits 0 on a jevlin call', r3.ok, r3.out.slice(0, 200))
if (r3.out.trim()) {
  let parsed = null
  try { parsed = JSON.parse(r3.out) } catch {}
  ok('surface.mjs emits valid JSON', !!parsed, r3.out.slice(0, 120))
  ok('it uses systemMessage (reaches the user), not additionalContext (reaches the model)',
    !!parsed?.hookSpecificOutput?.systemMessage)
}

// watch.mjs must exit 0 and stay silent when disabled, and never touch a sensitive path
const r4 = run('watch.mjs', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }, { JEVLIN_WATCH: 'off' })
ok('watch.mjs exits 0 when disabled', r4.ok && r4.out.trim() === '', r4.out.slice(0, 200))
const r5 = run('watch.mjs', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'x/.env', old_string: 'a', new_string: 'b' } }, { JEVLIN_WATCH: 'on' })
ok('watch.mjs refuses a sensitive path', r5.ok && r5.out.trim() === '', r5.out.slice(0, 200))

// malformed input must never take a session down
for (const junk of ['', 'not json', '{}', 'null', '[]'])
  ok(`hooks survive malformed stdin: ${JSON.stringify(junk).slice(0, 12)}`,
    run('surface.mjs', junk === '' ? '' : JSON.parse(junk === 'not json' ? '"not json"' : junk)).ok)

for (const f of [promptFile, join(STATE_DIR, `seen-${SID}.json`), join(STATE_DIR, `tally-${SID}.json`)])
  try { rmSync(f) } catch {}

console.log(fail ? `\n${fail} HOOK FAILURES` : '\nhooks OK')
process.exit(fail ? 1 : 0)
