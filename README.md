# jev

**Fast judgement calls for coding agents.** Narrow hundreds of candidates to the few that
matter, or get a yes/no over a blob of text — in one round trip, for a fraction of a cent.

```bash
git ls-files | jev filter "relevant to adding Stripe webhooks" --top 10
npm run build 2>&1 | tail -100 | jev ask "the build succeeded" && echo ok
rg -n TODO src | jev filter "a real blocker, not a nice-to-have" --min 0.7
```

Coding agents burn whole turns on *deciding*: which of these 300 files matter, which of these
40 grep hits are real, did that build actually pass. `jev` answers 400 such questions in ~1.5s
for $0.0004, so the agent can spend its turns on the work instead.

It is built on [Jev](https://openrouter.ai), a decision model that returns calibrated
probabilities and **cannot write text**. So it replaces none of your agent's work — only the
judging.

## Install

```bash
npm install -g jev-cli
```

**Bring your own key.** `jev` calls OpenRouter with *your* credentials and never bundles or
phones home to anyone else's:

```bash
export OPENROUTER_API_KEY=sk-or-...     # get one at https://openrouter.ai/keys
# or, to keep it out of your shell profile:
mkdir -p ~/.config/jev && echo 'OPENROUTER_API_KEY=sk-or-...' > ~/.config/jev/env

jev check    # confirms the key and prints which source it came from
```

The key is read at runtime from, in order: `--key`, `$JEV_API_KEY`, `$OPENROUTER_API_KEY`,
`~/.config/jev/env`, then `./.dev.vars`, `./.env.local`, `./.env`. The source is always named
on the receipt, so a stray key in the repo you happen to be in can never be used silently.

To teach Claude Code and Codex when to reach for it:

```bash
curl -fsSL https://raw.githubusercontent.com/USERNAME/jev-cli/main/install.sh | bash
# or, from a clone: ./install.sh
```

That symlinks the skill into `~/.claude/skills` and `~/.codex/skills` if they exist. Nothing
else is touched.

## What it is actually good at

Benchmarked against a lexical-overlap baseline on 24 real commits (`SPIKE-RESULTS.md`), with
half the tasks hand-rewritten so the commit message couldn't give the answer away:

| | baseline | jev |
|---|---|---|
| a relevant file in the top 10 | 0.19 | **0.61** |
| small change (≤3 files), top 10 | 0.25 | **0.77** |
| large change (≥6 files), top 10 | 0.11 | **0.17** |

**It locates; it does not enumerate.** It reliably puts *a* relevant file in the top 3–5 of
150. It does **not** recover the full set of files a large change touches.

> Treat the output as where to start looking, never as the complete answer.

And the rule that keeps it honest: **if `grep` can express the question, use `grep`** — it is
faster, exact, and never wrong. Below ~30 candidates, just read them.

## Commands

```
jev filter <instructions>   candidates on stdin (one per line), the ones that qualify on stdout
jev ask <question>          stdin is one blob; THE EXIT CODE IS THE ANSWER
jev raw                     stdin {"state":…,"questions":…} straight through
jev check                   resolve the key, make one trivial call
jev stats                   what it has cost and how often it has degraded
```

Give candidates extra context with a TAB — everything after it is sent but never echoed:

```bash
git ls-files '*.ts' | xargs -I{} sh -c 'printf "%s\t%s\n" {} "$(head -3 {})"' \
  | jev filter "handles authentication" --top 10
```

One `--context "Next.js app, payments live in src/billing"` is charged once per chunk and
lifts every judgement — usually worth more than `--peek`.

## Knowing it was jev, and what it saved

Every run prints a receipt to stderr, marked so you can tell at a glance which model answered:

```
◆ jev 198 candidates → 5 kept · 2 chunks · top 5
  ├ jev         ████····················   0.8s  $0.00021
  └ opus-5      ████████████████████████ ~45s   ~$0.069   → 334x cheaper, 56x faster (est.)
```

The second row is what the same judgement would have cost the model you already use — picked up
automatically from `~/.claude/settings.json`, or set with `JEV_COMPARE_MODEL`.

**What is measured and what is not.** jev's own time and cost are measured. The comparison's
input side is measured too (the candidate text has to enter the model's context either way).
The output side — how much your model would *think* — is an assumption: ~12 tokens per
candidate at ~55 tok/s. Everything estimated is marked `~`, and you can tune it with
`JEV_COMPARE_OUTPUT_TOKENS` / `JEV_COMPARE_TPS` or turn it off with `JEV_COMPARE=off`.

**Below ~30 candidates it refuses to claim a win** and says so instead — nobody spends 400
reasoning tokens on six lines, and a tool that oversells itself against its own advice is not
worth trusting.

## Exit codes

| code | meaning | what a caller should do |
|---|---|---|
| 0 | answered, complete | use it |
| 1 | answered, and the answer is **no** | trust it — there is nothing there |
| 2 | bad flags | fix and retry |
| **3** | **degraded — jev never saw this** (no key, timeout, HTTP, cap) | **do it the slow way** |
| 4 | partial — some chunks failed | usable, but say the list is incomplete |

Exit 3 always prints nothing, so `jev filter … | xargs cat` fails loudly rather than quietly
working on a truncated world. **1 means jev thought about it and said no; 3 means it never
thought about it.** Results go to stdout, receipts to stderr, so pipes stay clean.

Defaults: `--top 20` and **no probability cut**. A rank survives miscalibration; a threshold
does not. `--min` is opt-in and its numbers are guesses — run `--all --scores` to see the real
distribution first. If stderr says `flat distribution`, jev did not understand the question.

Guardrails: input is capped at `--max-candidates` (2000) so a stray `find /` cannot bill you,
and there is a $1/day spend cap (`JEV_DAILY_CAP`).

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

`JEV_WATCH=shadow` (the default) logs what it *would* have said to
`~/.local/state/jev/watch.jsonl` without saying it. Read that for a day before setting `on`.
If it cries wolf twice in a day, delete it.

**What leaves your machine:** your request and a capped diff summary, every byte of which goes
through a secret redactor first (`scripts/test-redact.mjs` is its test suite), and nothing at
all from a path that looks sensitive by name (`.env`, `*.pem`, `id_rsa`, `credentials`, …).

## Privacy

`jev` talks to exactly one host — OpenRouter — with your key. No analytics, no telemetry, no
other network calls. The local usage log (`~/.local/state/jev/usage.jsonl`) records counts,
timings, cost and your instruction text, but **never candidate names, file contents or
`--context`**, so it is safe to `cat` on a screen share. `JEV_NO_LOG=1` turns it off.

Zero dependencies, Node 20+. `./uninstall.sh` reverses everything.

## License

MIT
