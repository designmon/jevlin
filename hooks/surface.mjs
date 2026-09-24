#!/usr/bin/env node
/**
 * PostToolUse, synchronous and network-free — makes jevlin visible inside the agent.
 *
 * Without this, a jevlin run is invisible: its receipt goes to stderr, which lands inside a
 * Bash tool result that Claude Code and the VS Code extension collapse into a summary row.
 * `systemMessage` is the one channel that puts a line in front of the person, so this hook
 * reads what jevlin already logged and surfaces a running tally for the session.
 *
 * It also delivers the drift watchdog's verdict, because that hook runs with `async: true`
 * and Claude Code discards an async hook's stdout.
 *
 * No network, no parsing of jevlin's human-readable output — it reads the usage log jevlin writes.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from '../core.mjs'

const DIR = STATE_DIR
const LOG = process.env.JEVLIN_LOG || join(DIR, 'usage.jsonl')

const money = (v) => (v >= 0.01 ? `$${v.toFixed(2)}` : v >= 0.0001 ? `$${v.toFixed(4)}` : `$${v.toFixed(6).replace(/0+$/, '')}`)
const secs = (s) => (s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`)
const times = (r) => (r >= 100 ? `${Math.round(r)}x` : `${r.toFixed(1)}x`)

try {
  let raw = ''
  for await (const c of process.stdin) raw += c
  const ev = JSON.parse(raw)
  const sid = ev.session_id ?? 'nosession'
  mkdirSync(DIR, { recursive: true })
  const messages = []

  // --- 1. the drift verdict the async watchdog could not deliver itself ---
  const driftFile = join(DIR, `drift-${sid}.json`)
  if (existsSync(driftFile)) {
    try {
      const d = JSON.parse(readFileSync(driftFile, 'utf8'))
      unlinkSync(driftFile)
      if (Date.now() - d.t < 10 * 60_000)
        messages.push(`⚠ jevlin drift: the edit to ${d.path} scored ${d.serves.toFixed(2)} for serving "${d.request}"`)
    } catch {}
  }

  // --- 2. a running tally of what jevlin has done this session ---
  const ranJev = ev.tool_name === 'Bash' && /(^|[\s;&|(])jevlin\s+(filter|rank|ask|raw)\b/.test(String(ev.tool_input?.command ?? ''))
  if (ranJev && existsSync(LOG)) {
    const markFile = join(DIR, `seen-${sid}.json`)
    let seen = null
    try { seen = JSON.parse(readFileSync(markFile, 'utf8')).t } catch {}
    if (!Number.isFinite(seen)) {
      // First jevlin call in this session. "This session" must not mean "everything ever
      // logged", so start the watermark just before this call rather than at zero.
      seen = Date.now() - 60_000
    }

    const fresh = []
    for (const line of readFileSync(LOG, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const r = JSON.parse(line)
        const t = Date.parse(r.t)
        if (Number.isFinite(t) && t > seen) fresh.push({ ...r, _t: t })
      } catch {}
    }
    if (fresh.length) {
      writeFileSync(markFile, JSON.stringify({ t: Math.max(...fresh.map((r) => r._t)) }))
      let tally = { calls: 0, sec: 0, cost: 0, estCost: 0, estSec: 0 }
      try { tally = { ...tally, ...JSON.parse(readFileSync(join(DIR, `tally-${sid}.json`), 'utf8')) } } catch {}
      for (const r of fresh) {
        tally.calls += 1
        tally.sec += r.elapsed ?? (r.ms ?? 0) / 1000
        tally.cost += r.cost ?? 0
        tally.estCost += r.estCost ?? 0
        tally.estSec += r.estSeconds ?? 0
      }
      writeFileSync(join(DIR, `tally-${sid}.json`), JSON.stringify(tally))

      const head = `◆ jevlin ×${tally.calls} this session · ${secs(tally.sec)} · ${money(tally.cost)}`
      messages.push(tally.estCost > 0 && tally.cost > 0
        ? `${head}  (your model: ~${secs(tally.estSec)}, ~${money(tally.estCost)} — ${times(tally.estCost / tally.cost)} cheaper, est.)`
        : head)
    }
  }

  if (messages.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', systemMessage: messages.join('\n') },
    }) + '\n')
  }
} catch { /* a hook must never break the session */ }
process.exit(0)
