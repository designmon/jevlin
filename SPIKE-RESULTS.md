# Phase 0 results — measured 2026-09-23

35 runs over 24 real commits in `figle-app` (134 files) and `boardroom-jev` (198 files).
Task = commit message; gold = the pre-existing files that commit changed; candidates = every
file tracked before it. One `noul` per file.

## Jev vs a lexical baseline (idf-weighted word overlap on paths, no model)

Hand-rephrased tasks — written from the message alone, before seeing any diff:

| metric | baseline | Jev | |
|---|---|---|---|
| MRR | 0.23 | **0.46** | 2.0x |
| recall@5 | 0.11 | **0.45** | 4.1x |
| recall@10 | 0.19 | **0.61** | 3.2x |
| recall@20 | 0.26 | **0.68** | 2.6x |

Jev is doing semantic work, not string matching. That is the result that justifies building.

## The split that actually matters

| task shape | recall@10 | precision@10 | median rank of first hit |
|---|---|---|---|
| **small** (<=3 files to change), n=20 | **0.77** | — | **3** |
| **big** (>=6 files to change), n=13 | 0.17 | 0.19 | — |

**Jev locates; it does not enumerate.** It reliably puts a relevant file in the top 3-5 of
~130-200. It does not recover the full set of files a large change touches — recall@10 of
0.17 there is not usable as an answer.

## Other findings

- **Post-hoc phrasing did not flatter the model.** Rephrased scored *better* (recall@10
  0.61 vs 0.49), so the benchmark's main methodological worry did not materialise, which
  makes the result more trustworthy rather than less.
- **Zero flat distributions** (0/35 with p95-p05 < 0.15) — Jev discriminated on every task.
- **Zero unanswered questions** across 35 runs and ~5,700 questions.
- **Latency is ~1.7s mean from a laptop**, not the 0.6s measured inside a Cloudflare Worker
  (range 0.3-5.4s; 198 files = 2 chunks). Still far below a subagent, but the 0.6s figure
  does not survive the trip over domestic wifi.
- **Cost $0.0002 per run** of ~130-200 files. $0.0067 for the whole benchmark.

## Verdict against the pre-registered gate

recall@10 on the rephrased half = 0.61, which is the middle band: **build it, but it is a
hint, never the answer.** The skill must say so, and must steer it at locating rather than
enumerating.
