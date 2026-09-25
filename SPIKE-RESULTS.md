# Measured results

Two benchmarks. The first is on real work and is the one to believe. The second is the one
the author designed before shipping, and it overstated the tool by four times — it is kept
below deliberately, as a worked example of how a benchmark flatters the thing it tests.

---

## Real tasks from real sessions (2026-09-24) — believe this one

33 genuine "go and find the relevant code" tasks, taken from one developer's actual agent
sessions over 30 days. Ground truth is the files that session went on to edit after the
exploration. Candidates are every tracked file in the repo (130–210 files).

| | synthetic benchmark (below) | **real tasks** |
|---|---|---|
| recall@10 | 0.61 | **0.15** |
| precision@10 | — | **0.14** |
| at least one correct file in the top 10 | — | **58%** |
| median rank of the first correct file | 3 | **5** |

**It surfaces roughly one in seven of the files the work actually touched, and points
somewhere useful a bit over half the time.** That is not good enough to replace a search.

Split by task size, and note this *inverts* the synthetic finding:

| task shape | recall@10 | one correct file in top 10 |
|---|---|---|
| small (≤3 files touched), n=11 | 0.18 | 36% |
| enumeration (≥6 files touched), n=21 | 0.12 | 67% |

The higher hit-rate on big tasks is arithmetic, not skill — with more target files you are
likelier to clip one by chance.

### Why the synthetic benchmark was wrong

It used **commit messages** as the task. A commit message is written after the work and
describes it accurately, often naming the very concepts in the filenames. Real prompts are
terse and oblique — *"Rounds client UI"*, *"Phase 3 client: instance ids"*. Far less signal.
If you benchmark a retrieval tool with hindsight-written queries, you will overestimate it.

### Caveats, stated fairly — none of which rescue the number

- Ground truth is "files edited after the exploration", which includes incidental edits.
- The repositories moved between the sessions and the measurement; files that no longer
  exist were excluded from the gold sets.
- A person writing a query deliberately might phrase it better than an agent's terse label.

Being generous on all three does not get near 0.5.

### Reproduce it on your own work

`scripts/bench-tasks.mjs` takes a JSON array of `{repo, task, gold}` and reports the same
table. Build that file from whatever ground truth you have — commits, tickets, or your own
agent history — and see whether it does better for you than it did here.

---

## Synthetic benchmark (2026-09-23) — the one that was wrong

35 runs over 24 real commits in two private repositories (134 and 198 tracked files).
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
