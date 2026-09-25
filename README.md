# jevlin

**Fast judgement calls for coding agents.** Narrow hundreds of candidates to the few that
matter, or get a yes/no over a blob of text — in one round trip, for a fraction of a cent.

```bash
git ls-files | jevlin filter "relevant to adding Stripe webhooks" --top 10
npm run build 2>&1 | tail -100 | jevlin ask "the build succeeded" && echo ok
rg -n TODO src | jevlin filter "a real blocker, not a nice-to-have" --min 0.7
```

Coding agents burn whole turns on *deciding*: which of these 300 files matter, which of these
40 grep hits are real, did that build actually pass. `jevlin` answers 400 such questions in ~1.5s
for $0.0004, so the agent can spend its turns on the work instead.

It is built on [Jev](https://openrouter.ai), a decision model that returns calibrated
probabilities and **cannot write text**. So it replaces none of your agent's work — only the
judging.

*Jev's javelin: thrown fast, lands on a point.* It will put you next to the right file; it
won't hand you the whole field. The numbers below say exactly how far that goes.

## Install

```bash
npm install -g jevlin
```

```bash
jevlin init
```

`init` walks you through it: it points you at https://openrouter.ai/keys, takes your key
without echoing it or putting it in your shell history, **checks it works before writing
anything**, saves it to `~/.config/jevlin/env` with `chmod 600`, and offers to install the
agent skill into Claude Code and Codex if it finds them.

**Bring your own key.** jevlin calls OpenRouter with *your* credentials, billed to you, and
never bundles or proxies anyone else's.

Prefer to do it by hand:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

```bash
jevlin check
```

The key is read at runtime from, in order: `--key`, `$JEVLIN_API_KEY`,
`$OPENROUTER_API_KEY`, `~/.config/jevlin/env`, then `./.dev.vars`, `./.env.local`, `./.env`.
The source is always named on the receipt, so a stray key in whichever repo you happen to be
in can never be used silently.

### What leaves your machine

Your key goes in the `Authorization` header and nowhere else — never in a request body, never
in the local log. There is exactly one network call in the whole package, to
`openrouter.ai`; no analytics, no telemetry.

What *is* sent is your instruction and the candidate lines you pipe in — file paths for
`git ls-files`, and actual file contents if you use `--peek`. On a work machine with
proprietary code, that is worth checking against your employer's policy before piping a repo
through it.

## What it is actually good at

**Measured on real work, it is weak.** 33 genuine "find the relevant code" tasks from a
developer's own agent sessions, ground truth being the files that work went on to edit:

| | jevlin |
|---|---|
| recall@10 | **0.15** |
| precision@10 | **0.14** |
| at least one correct file in the top 10 | **58%** |

It surfaces roughly **one in seven** of the files the work actually touched, and points
somewhere useful a bit over half the time.

An earlier synthetic benchmark in `SPIKE-RESULTS.md` reported 0.61 — it used commit messages
as queries, which are written *after* the work and name the very concepts in the filenames.
That overstated the tool by four times. Both numbers are published there, because the gap
between them is the most useful thing this repository contains.

**So: treat any output as a hint to check, never as an answer.** And the rule that still
holds — **if `grep` can express the question, use `grep`**: faster, exact, never wrong.
Below ~30 candidates, just read them.

Where it does hold up, on the same measurements: **`jevlin ask`** over a blob of text —
0.98 on a passing build, 0.01 on a failing one, in under half a second.

## Commands

```
jevlin filter <instructions>   candidates on stdin (one per line), the ones that qualify on stdout
jevlin ask <question>          stdin is one blob; THE EXIT CODE IS THE ANSWER
jevlin raw                     stdin {"state":…,"questions":…} straight through
jevlin check                   resolve the key, make one trivial call
jevlin stats                   what it has cost and how often it has degraded
```

Give candidates extra context with a TAB — everything after it is sent but never echoed:

```bash
git ls-files '*.ts' | xargs -I{} sh -c 'printf "%s\t%s\n" {} "$(head -3 {})"' \
  | jevlin filter "handles authentication" --top 10
```

One `--context "Next.js app, payments live in src/billing"` is charged once per chunk and
lifts every judgement — usually worth more than `--peek`.

## Knowing it was jevlin, and what it saved

Every run prints a receipt to stderr, marked so you can tell at a glance which model answered:

```
◆ jevlin 198 candidates → 5 kept · 2 chunks · top 5
  ├ jevlin         ████····················   0.8s  $0.00021
  └ opus-5      ████████████████████████ ~45s   ~$0.069   → 334x cheaper, 56x faster (est.)
```

The second row is what the same judgement would have cost the model you already use — picked up
automatically from `~/.claude/settings.json`, or set with `JEVLIN_COMPARE_MODEL`.

**What is measured and what is not.** jevlin's own time and cost are measured. The comparison's
input side is measured too (the candidate text has to enter the model's context either way).
The output side — how much your model would *think* — is an assumption: ~12 tokens per
candidate at ~55 tok/s. Everything estimated is marked `~`, and you can tune it with
`JEVLIN_COMPARE_OUTPUT_TOKENS` / `JEVLIN_COMPARE_TPS` or turn it off with `JEVLIN_COMPARE=off`.

**Below ~30 candidates it refuses to claim a win** and says so instead — nobody spends 400
reasoning tokens on six lines, and a tool that oversells itself against its own advice is not
worth trusting.

## Exit codes

| code | meaning | what a caller should do |
|---|---|---|
| 0 | answered, complete | use it |
| 1 | answered, and the answer is **no** | trust it — there is nothing there |
| 2 | bad flags | fix and retry |
| **3** | **degraded — jevlin never saw this** (no key, timeout, HTTP, cap) | **do it the slow way** |
| 4 | partial — some chunks failed | usable, but say the list is incomplete |

Exit 3 always prints nothing, so `jevlin filter … | xargs cat` fails loudly rather than quietly
working on a truncated world. **1 means jevlin thought about it and said no; 3 means it never
thought about it.** Results go to stdout, receipts to stderr, so pipes stay clean.

Defaults: `--top 20` and **no probability cut**. A rank survives miscalibration; a threshold
does not. `--min` is opt-in and its numbers are guesses — run `--all --scores` to see the real
distribution first. If stderr says `flat distribution`, jevlin did not understand the question.

Guardrails: input is capped at `--max-candidates` (2000) so a stray `find /` cannot bill you,
and there is a $1/day spend cap (`JEVLIN_DAILY_CAP`).

## Optional: the drift watchdog

`hooks/watch.mjs` is a Claude Code `PostToolUse` hook that, after each edit, asks whether the
change still serves what you asked for. It runs `async` (no latency) and **cannot approve or
block anything** — the edit has already happened; it can only tell the model it may have
wandered. ~$0.00005 per edit.

It is **not installed by default**. To try it, add to `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node <path>/hooks/remember.mjs", "timeout": 5 }] }],
  "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit",
    "hooks": [{ "type": "command", "command": "node <path>/hooks/watch.mjs", "timeout": 15, "async": true }] }]
}
```

`JEVLIN_WATCH=shadow` (the default) logs what it *would* have said to
`~/.local/state/jevlin/watch.jsonl` without saying it. Read that for a day before setting `on`.
If it cries wolf twice in a day, delete it.

**What leaves your machine:** your request and a capped diff summary, every byte of which goes
through a secret redactor first (`scripts/test-redact.mjs` is its test suite), and nothing at
all from a path that looks sensitive by name (`.env`, `*.pem`, `id_rsa`, `credentials`, …).

## Privacy

`jevlin` talks to exactly one host — OpenRouter — with your key. No analytics, no telemetry, no
other network calls. The local usage log (`~/.local/state/jevlin/usage.jsonl`) records counts,
timings, cost and your instruction text, but **never candidate names, file contents or
`--context`**, so it is safe to `cat` on a screen share. `JEVLIN_NO_LOG=1` turns it off.

Zero dependencies, Node 20+. `./uninstall.sh` reverses everything.

## License

MIT
