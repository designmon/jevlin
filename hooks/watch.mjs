#!/usr/bin/env node
/**
 * PostToolUse (Edit|Write|MultiEdit), async — the drift watchdog.
 *
 * Two yes/no questions against what she actually asked for. It cannot approve anything and
 * cannot block anything: the edit has already happened, and PostToolUse has no
 * permissionDecision. The worst case is a wrong warning, which is why it is allowed to exist.
 *
 * JEVLIN_WATCH=shadow (default) logs what it would have said and emits nothing.
 * JEVLIN_WATCH=on emits the warning to the model.  JEVLIN_WATCH=off disables it.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveKey, decide, redact, STATE_DIR } from '../core.mjs'

const DIR = STATE_DIR
const MODE = process.env.JEVLIN_WATCH ?? 'shadow'
const SERVES_BELOW = 0.35   // conservative on purpose: a watchdog that cries wolf gets deleted
const SURPRISE_ABOVE = 0.85
/** Never send anything from a path that is sensitive by name — not even to ask about it. */
const SENSITIVE = /(^|\/)(\.env|\.dev\.vars|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials)|\.(pem|key|p12|pfx)$/i

const log = (row) => {
  try { mkdirSync(DIR, { recursive: true }); appendFileSync(join(DIR, 'watch.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n') } catch {}
}

try {
  if (MODE === 'off') process.exit(0)
  let raw = ''
  for await (const c of process.stdin) raw += c
  const ev = JSON.parse(raw)
  const input = ev.tool_input ?? {}
  const path = input.file_path ?? input.notebook_path ?? ''
  if (!path || SENSITIVE.test(path)) process.exit(0)

  let cached
  try { cached = JSON.parse(readFileSync(join(DIR, `prompt-${ev.session_id}.json`), 'utf8')) } catch {}
  if (!cached?.prompt) process.exit(0)          // nothing to judge against

  // A summary of the change, never the whole file.
  const edits = input.edits ?? (input.old_string !== undefined ? [{ old_string: input.old_string, new_string: input.new_string }] : [])
  const body = edits.length
    ? edits.map((e) => `- ${String(e.old_string ?? '').slice(0, 300)}\n+ ${String(e.new_string ?? '').slice(0, 300)}`).join('\n')
    : String(input.content ?? '').slice(0, 800)
  const { text: safe, redactions } = redact(body.slice(0, 2000))

  const { key } = resolveKey()
  if (!key) process.exit(0)

  const out = await decide(key,
    { request: cached.prompt, file: path, change: safe, tool: ev.tool_name, agent: ev.agent_type ?? 'main' },
    {
      serves: { type: 'noul', instructions: 'This change serves the request in `request`. Answer yes if it is a plausible step toward it, including setup, refactoring or tests along the way.' },
      surprise: { type: 'noul', instructions: 'The person who wrote `request` would be surprised or unhappy to find this change was made on their behalf.' },
    },
    { timeoutMs: 10_000 })

  if (!out.ok) { log({ path, mode: MODE, reason: out.reason }); process.exit(0) }
  const serves = out.answers.serves?.noul ?? 1
  const surprise = out.answers.surprise?.noul ?? 0
  const drift = serves < SERVES_BELOW || surprise > SURPRISE_ABOVE
  log({ path, mode: MODE, serves, surprise, drift, cost: out.cost, ms: out.ms, request: cached.prompt.slice(0, 120) })

  // This hook runs with `async: true` so it never delays an edit — and Claude Code
  // DISCARDS the stdout of an async hook. So the verdict is handed to surface.mjs (which
  // runs synchronously and costs nothing) to deliver on the next tool call. One edit late
  // is fine: this catches an agent wandering, not a single keystroke.
  if (drift && MODE === 'on') {
    try {
      writeFileSync(join(DIR, `drift-${ev.session_id}.json`), JSON.stringify({
        path, serves, surprise, request: cached.prompt.slice(0, 160), t: Date.now(),
      }))
    } catch {}
  }
  if (redactions) log({ path, redactions })
} catch { /* a hook must never break the session */ }
process.exit(0)
