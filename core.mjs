/**
 * Jev — TypeSafe's decision model. It answers many questions at once and does not write.
 *
 * One endpoint, one body: { model, state, questions }. Each question is a yes/no
 * (`noul` -> a calibrated probability), a pick among labelled options (`choice`,
 * <=255 labels), or a place on an ordered scale (`score`). Measured 2026-09-21:
 * 0.3s for 20 questions, 0.6s for 150, about $0.0006 for the 150. Context 32k.
 *
 * The rule this follows, and the reason nothing here throws: a Jev that is down, slow or unset leaves the caller doing exactly what
 * it did before. A failure is a reason, never an exception.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [major] = process.versions.node.split('.').map(Number)
if (major < 20) {
  process.stderr.write(`jev needs Node 20 or newer (found ${process.versions.node}).\n`)
  process.exit(3)
}

export const JEV_MODEL = 'typesafe/jev-1.13-20260917'
export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
export const JEV_TIMEOUT_MS = 8_000

/**
 * Pessimistic on purpose: paths and camelCase tokenize worse than prose, and the endpoint
 * wraps every question in scaffolding we never see. Started at 3.6 (raw bytes/token) and
 * measured `usage.input_tokens` against it over real runs and settled here: the original
 * 1.98x overshoot came mostly from under-counting per-question scaffolding (now 60 tokens),
 * not from the bytes ratio. Tuned to land slightly conservative (~0.8x), so chunks are a
 * little smaller than they need to be rather than one byte too big. `jev stats` reports the ratio; keep it near 1.0.
 */
export const BYTES_PER_TOKEN = 2.8
/** Of Jev's 32k, leaving room for whatever the endpoint wraps around us. */
export const CHUNK_TOKEN_BUDGET = 24_000
export const MAX_Q = { noul: 150, choice: 80, score: 80 }

export const est = (x) =>
  Math.ceil(Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x), 'utf8') / BYTES_PER_TOKEN)

/** First non-empty wins. The caller reports which source won, so a stray repo key is visible. */
export function resolveKey(explicit) {
  const tries = [
    ['--key', explicit],
    ['env:JEV_API_KEY', process.env.JEV_API_KEY],
    ['env:OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY],
    ...[
      join(homedir(), '.config/jev/env'),
      join(process.cwd(), '.dev.vars'),
      join(process.cwd(), '.env.local'),
      join(process.cwd(), '.env'),
    ].map((f) => [f, fromFile(f)]),
  ]
  for (const [source, key] of tries) if (key && key.trim()) return { key: key.trim(), source }
  return { key: null, source: null }
}

function fromFile(path) {
  try {
    const m = readFileSync(path, 'utf8').match(/^\s*(?:export\s+)?(?:JEV_API_KEY|OPENROUTER_API_KEY)\s*=\s*(.+)$/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

const unit = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Keeps only answers that were asked for and are readable, dropping each bad one
 * individually so a single malformed answer doesn't cost the rest. Returns null only
 * when there is nothing readable at all.
 */
export function readAnswers(raw, questions) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const [id, a] of Object.entries(raw)) {
    const q = questions[id]
    if (!q || !a || typeof a !== 'object') continue
    if (q.type === 'noul') {
      if (typeof a.noul === 'number' && a.noul >= 0 && a.noul <= 1) out[id] = { noul: a.noul }
    } else if (q.type === 'choice') {
      if (typeof a.choice === 'string' && a.choice in q.criteria)
        out[id] = { choice: a.choice, confidence: unit(a.confidence), probabilities: a.probabilities ?? {} }
    } else if (q.type === 'score') {
      if (typeof a.score === 'number' && a.score >= 0 && a.score <= q.criteria.length - 1)
        out[id] = { score: a.score, confidence: unit(a.confidence) }
    }
  }
  return out
}

/** One attempt, no retries, never throws. */
export async function decide(key, state, questions, opts = {}) {
  if (!key) return { ok: false, reason: 'no-key', error: 'no OPENROUTER_API_KEY; run `jev check`' }
  const ids = Object.keys(questions)
  if (!ids.length) return { ok: true, answers: {}, ms: 0, cost: 0, inTok: 0, outTok: 0, missing: [] }

  const started = Date.now()
  let res
  try {
    res = await fetch(opts.url ?? process.env.JEV_BASE_URL ?? JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: opts.model ?? JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? JEV_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'network',
      retry: !timedOut,
      error: String(err?.message ?? err).slice(0, 160),
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const flat = body.replace(/\s+/g, ' ').slice(0, 200)
    return {
      ok: false,
      reason: `http-${res.status}`,
      retry: res.status === 429 || res.status >= 500,
      // A 400 about length means the estimator was wrong: the caller re-splits and retries once.
      tooBig: res.status === 400 && /context|token|too (large|long)/i.test(flat),
      error: flat,
    }
  }

  let data
  try {
    data = await res.json()
  } catch {
    return { ok: false, reason: 'parse', error: 'not JSON' }
  }
  const answers = readAnswers(data?.answers, questions)
  if (!answers) return { ok: false, reason: 'parse', error: 'no answers field' }

  const u = data.usage ?? {}
  return {
    ok: true,
    answers,
    ms: Date.now() - started,
    cost: unit(u.cost),
    inTok: unit(u.input_tokens),
    outTok: unit(u.output_tokens),
    // Asked but unanswered. jevClient drops these silently because every caller there has a
    // per-field fallback; a CLI has none, so it must surface them — and never treat a missing
    // answer as a negative one.
    missing: ids.filter((id) => !(id in answers)),
  }
}

/**
 * Splits candidates into chunks that fit the window and stay fast.
 *
 * Two caps: tokens (the 32k wall) and question count (latency). Then the chunks are
 * levelled, because every chunk is in flight at once and the run costs as long as the
 * fattest one — a 149/1 split has the same wall clock as 75/75 and twice the tail risk.
 */
export function chunkCandidates(items, sizeOf, { room, maxQ }) {
  let chunks = 1, used = 0, n = 0
  for (const item of items) {
    const size = sizeOf(item)
    if (n > 0 && (used + size > room || n >= maxQ)) { chunks++; used = 0; n = 0 }
    used += size; n++
  }
  for (;;) {
    const target = Math.min(maxQ, Math.ceil(items.length / chunks))
    const out = []
    let cur = [], fill = 0
    for (const item of items) {
      const size = sizeOf(item)
      if (cur.length > 0 && (cur.length >= target || fill + size > room)) { out.push(cur); cur = []; fill = 0 }
      cur.push(item); fill += size
    }
    if (cur.length) out.push(cur)
    if (out.length <= chunks) return out
    chunks = out.length   // a fat item forced an extra chunk; re-level around the new count
  }
}

/** Runs chunks in parallel with a small pool, retrying a 429/5xx once and re-splitting a too-big chunk once. */
export async function runChunks(key, state, chunks, buildQuestions, opts = {}) {
  const concurrency = opts.concurrency ?? 4
  const results = new Array(chunks.length)
  let next = 0

  const attempt = async (items, depth = 0) => {
    const questions = buildQuestions(items)
    const out = await decide(key, state, questions, opts)
    if (out.ok) return [out]
    if (out.tooBig && items.length > 1 && depth === 0) {
      const mid = Math.ceil(items.length / 2)
      const [a, b] = await Promise.all([attempt(items.slice(0, mid), 1), attempt(items.slice(mid), 1)])
      return [...a, ...b]
    }
    if (out.retry && depth === 0) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 300))
      const again = await decide(key, state, questions, opts)
      return [again]
    }
    return [out]
  }

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= chunks.length) return
      results[i] = await attempt(chunks[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
  return results.flat()
}

/**
 * Strips anything that looks like a credential before text leaves this machine.
 *
 * The watchdog sends a diff summary to a third party, so this runs on every byte of it.
 * Order matters: the labelled-assignment rule runs first so `TOKEN=<short>` is caught even
 * when the value is too short or too low-entropy for the generic rule to see it.
 */
export function redact(text) {
  // Always the same shape, so `redact(x).text` is never undefined for a caller that
  // then ships it over the wire.
  if (!text) return { text: '', redactions: 0 }
  let n = 0
  const hit = () => { n++; return '<redacted>' }
  const out = String(text)
    // labelled assignments: KEY=..., "password": "...", -H 'Authorization: Bearer ...'
    .replace(/((?:api[_-]?key|secret|token|password|passwd|auth|bearer|credential)[a-z_]*)(["']?\s*[:=]\s*)(["']?)([^\s"',;)]{4,})\3/gi,
      (_, k, sep, q, _v) => `${k}${sep}${q}${hit()}${q}`)
    .replace(/(-H\s+["'][^"']*:\s*)([^"']+)(["'])/gi, (_, h, _v, q) => `${h}${hit()}${q}`)
    // provider-shaped keys
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, hit)
    .replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{16,}/g, hit)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, hit)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, hit)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, hit)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, hit)
    // JWTs and URLs carrying inline credentials
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, hit)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_, s) => `${s}${hit()}@`)
    // anything left that is long and high-entropy enough to be a key
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, hit)
  return { text: out, redactions: n }
}
