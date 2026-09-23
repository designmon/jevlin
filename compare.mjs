/**
 * "What would this have cost if the agent had judged it itself?"
 *
 * The honest framing: when an agent triages 200 candidates without jev, it must read them
 * into context and reason over them. We know jev's real token usage, and we can count the
 * candidate text exactly — so the INPUT side is measured, not guessed. The output side (how
 * much the model would think) is an assumption, and every estimate is marked with ~.
 *
 * Prices are per million tokens, from the Anthropic pricing table (2026-06).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PRICES = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  // common non-Anthropic comparisons, for Codex and others
  'gpt-5': [1.25, 10], 'gpt-5-mini': [0.25, 2],
}
const ALIASES = {
  opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1', default: 'claude-opus-5',
}

/** How many tokens the agent would generate reasoning over N candidates, and how fast. */
const OUT_PER_CANDIDATE = Number(process.env.JEV_COMPARE_OUTPUT_TOKENS ?? 12)
const OUT_MIN = 400, OUT_MAX = 6000
const TOKENS_PER_SEC = Number(process.env.JEV_COMPARE_TPS ?? 55)
const ROUND_TRIP_S = 1.5
/**
 * Below this, the comparison is not credible: nobody spends 400 reasoning tokens on six
 * lines, and the skill tells agents to just read them. Claiming "798x cheaper" on a
 * three-candidate run would be the tool overselling itself against its own advice.
 */
export const BREAK_EVEN = 30

/** Which model to compare against: explicit, else whatever Claude Code is configured to use. */
export function compareModel() {
  const raw = process.env.JEV_COMPARE_MODEL
    ?? (() => {
      try { return JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8')).model } catch { return null }
    })()
    ?? 'default'
  const id = ALIASES[raw] ?? raw
  return PRICES[id] ? { id, price: PRICES[id] } : null
}

export function estimateAgentCost({ n, candidateTokens, instructionTokens = 0 }) {
  const m = compareModel()
  if (!m) return null
  if (n > 1 && n < BREAK_EVEN) return { belowBreakEven: true, n }
  const inTok = candidateTokens + instructionTokens + 200          // the list must enter context
  const outTok = Math.max(OUT_MIN, Math.min(OUT_MAX, n * OUT_PER_CANDIDATE))
  const cost = (inTok * m.price[0] + outTok * m.price[1]) / 1e6
  const seconds = outTok / TOKENS_PER_SEC + ROUND_TRIP_S
  return { model: m.id, inTok, outTok, cost, seconds }
}

// ---- rendering -------------------------------------------------------------

const useColour = () => process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const C = (code, s) => (useColour() ? `\x1b[${code}m${s}\x1b[0m` : s)
export const cyan = (s) => C('36', s)
export const bold = (s) => C('1', s)
export const dim = (s) => C('2', s)

const money = (v) => {
  if (v >= 0.01) return `$${v.toFixed(3)}`
  if (v >= 0.0001) return `$${v.toFixed(5)}`
  if (v > 0) return `$${v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')}`   // readable, never 1.2e-5
  return '$0'
}
const secs = (s) => (s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`)
const times = (r) => (r >= 100 ? `${Math.round(r)}x` : r >= 10 ? `${r.toFixed(0)}x` : `${r.toFixed(1)}x`)

/**
 * The saving as a ratio, but only when a ratio means anything. A zero or near-zero jev
 * cost (a cached or mocked response) would otherwise render "Infinityx cheaper".
 */
function ratios(jevCost, jevSeconds, est) {
  const parts = []
  const r = (a, b) => (b > 0 && Number.isFinite(a / b) ? a / b : null)
  const c = r(est.cost, jevCost), t = jevSeconds > 0.05 ? r(est.seconds, jevSeconds) : null
  parts.push(c ? `${times(c)} cheaper` : `saves ~${money(est.cost)}`)
  parts.push(t ? `${times(t)} faster` : `saves ~${secs(est.seconds)}`)
  return `\u2192 ${parts.join(', ')} (est.)`
}

/** A two-bar chart: what jev spent, against what the configured model would have. */
export function renderComparison({ jevSeconds, jevCost, est, label = 'jev' }) {
  if (!est) return ''
  if (est.belowBreakEven)
    return dim(`  ${secs(jevSeconds)} · ${money(jevCost)} · only ${est.n} candidates — reading them directly is usually cheaper than asking`)
  const W = 24
  const maxS = Math.max(jevSeconds, est.seconds), maxC = Math.max(jevCost, est.cost)
  const bar = (v, max) => {
    const filled = max > 0 ? Math.max(1, Math.round((v / max) * W)) : 1
    return '█'.repeat(filled) + dim('·'.repeat(W - filled))
  }
  const name = (s) => s.replace(/^claude-/, '').padEnd(11)
  const lines = [
    `  ${dim('├')} ${cyan(name(label))} ${bar(jevSeconds, maxS)} ${secs(jevSeconds).padStart(6)} ${money(jevCost).padStart(9)}`,
    `  ${dim('└')} ${dim(name(est.model))} ${dim(bar(est.seconds, maxS))} ${dim('~' + secs(est.seconds))}${dim(('~' + money(est.cost)).padStart(10))}` +
      `   ${dim(ratios(jevCost, jevSeconds, est))}`,
  ]
  return lines.join('\n')
}

/** The badge that makes it unmistakable which model answered. */
export function badge(text) {
  return `${cyan('◆')} ${bold(cyan('jev'))} ${text}`
}
