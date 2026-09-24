#!/usr/bin/env node
/**
 * UserPromptSubmit — caches what she just asked for, so the watchdog can judge against it.
 *
 * `transcript_path` is documented to lag the live conversation and may not contain the
 * current turn, which is exactly when it matters. This hook gets the prompt handed to it
 * directly, so it is both cheaper and correct. It writes nothing to stdout.
 */
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { STATE_DIR } from '../core.mjs'
import { join } from 'node:path'

const DIR = STATE_DIR
const DAY = 86_400_000

try {
  let raw = ''
  for await (const c of process.stdin) raw += c
  const { session_id: id, prompt } = JSON.parse(raw)
  if (id && typeof prompt === 'string' && prompt.trim()) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, `prompt-${id}.json`), JSON.stringify({ prompt: prompt.slice(0, 4000), t: Date.now() }))
    // Prune, so the directory doesn't grow forever.
    for (const f of readdirSync(DIR)) {
      if (!f.startsWith('prompt-')) continue
      try { if (Date.now() - statSync(join(DIR, f)).mtimeMs > DAY) unlinkSync(join(DIR, f)) } catch {}
    }
  }
} catch { /* a hook must never break the session */ }
process.exit(0)
