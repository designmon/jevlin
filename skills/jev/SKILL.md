---
name: jev
description: Narrow a long list of candidates to the few that matter, or get a fast yes/no over a blob of text, using the `jev` CLI. Use when choosing which of many files, search hits, commits, branches, log lines or test failures are relevant to a task; when triaging grep/rg output; or when judging whether a build passed, a diff is risky, or a failure is real. Only worth it above ~30 candidates and when the criterion is semantic rather than something grep can match exactly.
---

`jev` asks a decision model many yes/no questions in **one** round trip — 400 candidates in
~1.5s for $0.0004. It cannot write text. It only judges.

## When it is worth a turn

Use it when **all three** hold:
1. The criterion is **semantic** — "relevant to adding webhooks", not "contains the string `stripe`".
2. There are **more than ~30 candidates**. Below that, just read them.
3. You would otherwise **read a pile of files or spawn a subagent** to decide.

**If `grep`/`rg` can answer it, use grep.** It is faster, exact, and never wrong. `jev` earns
its turn only where no pattern expresses the question.

## What it is measured to do — and not do

Benchmarked on 24 real commits across two repos (`~/jev/SPIKE-RESULTS.md`), against a
lexical-overlap baseline:

| | baseline | jev |
|---|---|---|
| a relevant file in the top 10 | 0.19 | **0.61** |
| small change (<=3 files), top 10 | 0.25 | **0.77** |
| **large change (>=6 files), top 10** | 0.11 | **0.17** |

**It locates; it does not enumerate.** It reliably puts *a* relevant file in the top 3-5 of
130-200. It does **not** recover the full set of files a large change touches. So:

> Treat the output as **where to start looking**, never as the complete answer. Always verify
> by reading. Never delete, refactor or report based on a `jev` list alone.

## Commands

```bash
# narrow candidates: one per line on stdin, the ones that qualify on stdout
git ls-files | jev filter "relevant to adding Stripe webhook handling" --top 10
rg -n "TODO" src | jev filter "a real blocker, not a nice-to-have" --min 0.7
git log --oneline -50 | jev filter "likely to have broken the build" --rank --scores

# yes/no over a blob: THE EXIT CODE IS THE ANSWER
npm run build 2>&1 | tail -100 | jev ask "the build succeeded with no type errors" && echo ok
git diff | jev ask "this changes a public API or an on-disk format" --min 0.5

# anything else: pass {state, questions} straight through
echo '{"state":{...},"questions":{"q":{"type":"noul","instructions":"..."}}}' | jev raw
```

Give candidates context with a TAB — everything after it is sent to jev and never echoed:

```bash
git ls-files '*.ts' | xargs -I{} sh -c 'printf "%s\t%s\n" {} "$(head -3 {} | tr "\n" " ")"' \
  | jev filter "handles authentication" --top 10
```

One `--context "this is a Next.js app; payments live in src/billing"` is charged once per
chunk and lifts every judgement — it is worth more than `--peek`.

## Exit codes — check them

| code | meaning | what to do |
|---|---|---|
| 0 | answered, complete | use the output |
| 1 | answered, and the answer is **no** / nothing qualified | trust it; there is nothing there |
| 2 | your flags were wrong | fix and retry |
| **3** | **DEGRADED — jev never saw this** (no key, timeout, HTTP, daily cap) | **do the task the slow way** |
| 4 | PARTIAL — some chunks failed, results are a subset | use it, but say the list is incomplete |

Exit 3 always prints nothing, so `jev filter … | xargs cat` fails loudly rather than quietly
operating on a truncated world. **1 means jev thought about it and said no; 3 means it never
thought about it.** Never treat 3 as "nothing matched".

## Defaults

`--top 20` by default, and **no probability cut**. A rank survives miscalibration; a threshold
does not. `--min` is opt-in and its numbers are guesses — use `--all --scores` to see the real
distribution before trusting one. If stderr says `flat distribution`, jev did not understand
the question: rephrase it or add `--context`.

Receipts go to stderr, results to stdout, so piping stays clean. `jev stats` shows what it has
cost and how often it has degraded.
