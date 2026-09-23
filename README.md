# jev

Fast judgement calls for coding agents. Jev answers many yes/no questions in one round trip
and does not write a word — so it replaces none of an agent's work, only the *deciding*.

```bash
git ls-files | jev filter "relevant to adding Stripe webhooks" --top 10
npm run build 2>&1 | tail -100 | jev ask "the build succeeded" && echo ok
jev check      # is the key working
jev stats      # what has it cost, how often has it degraded
```

## What is here

| | |
|---|---|
| `core.mjs` | the only code that touches the network: `decide`, `readAnswers`, chunking, key ladder, `redact` |
| `jev.mjs` | the CLI → symlinked to `~/.local/bin/jev` |
| `skills/jev/SKILL.md` | one skill, symlinked into **both** `~/.claude/skills` and `~/.codex/skills` |
| `hooks/remember.mjs` | UserPromptSubmit — caches the request (the transcript lags, so this is the reliable source) |
| `hooks/watch.mjs` | PostToolUse, async — drift watchdog. Cannot approve or block anything. |
| `scripts/spike.mjs` | the Phase 0 benchmark |
| `scripts/baseline.mjs` | the lexical control it must beat |
| `scripts/test-redact.mjs` | the redactor's tests |
| `SPIKE-RESULTS.md` | **read this before trusting the tool** |

Zero dependencies, node 20+. `./uninstall.sh` puts everything back.

## What it is actually good at

Measured, not assumed (`SPIKE-RESULTS.md`): ~3x better than lexical matching at putting a
relevant file in the top 10. **It locates (recall@10 0.77 on small changes, median first hit
at rank 3 of ~150) and it does not enumerate (recall@10 0.17 on large changes).**

A starting point, never the answer. If `grep` can express the question, use grep.

## The watchdog

Runs `async`, so it adds no latency, and it has no power to approve or block — it can only
tell the model it may have drifted. `JEV_WATCH=shadow` (the default) logs what it would have
said without saying it; `on` enables it; `off` disables it. It never sends anything from a
path that looks sensitive by name, and everything it does send goes through `redact()` first.

Read `~/.local/state/jev/watch.jsonl` after a day of shadow before turning it on. If it cries
wolf twice in a day, raise the thresholds in `hooks/watch.mjs` or delete it.
