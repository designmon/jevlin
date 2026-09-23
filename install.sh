#!/usr/bin/env bash
# Installs the agent skill for whichever agents are present. The `jevlin` command itself comes
# from `npm i -g jevlin`; this only wires up the skill and (optionally) the drift watchdog.
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link() {
  if [ -d "$1" ]; then
    ln -sfn "$HERE/skills/jevlin" "$1/jev"
    echo "  skill -> $1/jev"
  fi
}
echo "installing the jevlin skill…"
link "$HOME/.claude/skills"
link "$HOME/.codex/skills"

echo
echo "next:"
echo "  1. export OPENROUTER_API_KEY=sk-or-...   (or put it in ~/.config/jevlin/env)"
echo "  2. jevlin check"
echo
echo "the drift watchdog is OPTIONAL and off unless you wire it up — see README.md."
