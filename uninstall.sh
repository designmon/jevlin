#!/usr/bin/env bash
# Undoes what install.sh did, and removes the optional hooks if you wired them up.
# It does not touch the `jevlin` command itself — that belongs to npm:
#   npm uninstall -g jevlin
set -u
N="$(command -v node)"

echo "removing the skill symlinks…"
for d in "$HOME/.claude/skills/jevlin" "$HOME/.codex/skills/jevlin"; do
  [ -L "$d" ] && rm -f "$d" && echo "  removed $d"
done

SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && [ -n "$N" ]; then
  echo "removing jevlin hooks from ~/.claude/settings.json…"
  "$N" -e '
const fs = require("fs")
const p = process.env.HOME + "/.claude/settings.json"
let s
try { s = JSON.parse(fs.readFileSync(p, "utf8")) } catch { console.log("  (could not parse settings.json — left untouched)"); process.exit(0) }
const mine = (g) => (g.hooks ?? []).some((h) => /jevlin[\/\\]hooks[\/\\]/.test(String(h.command ?? "")))
let removed = 0
for (const ev of Object.keys(s.hooks ?? {})) {
  const before = s.hooks[ev].length
  s.hooks[ev] = s.hooks[ev].filter((g) => !mine(g))
  removed += before - s.hooks[ev].length
  if (!s.hooks[ev].length) delete s.hooks[ev]
}
if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks
if (s.env) { delete s.env.JEVLIN_WATCH; if (!Object.keys(s.env).length) delete s.env }
if (s.permissions?.allow) s.permissions.allow = s.permissions.allow.filter((r) => r !== "Bash(jevlin *)")
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n")
console.log(`  removed ${removed} hook${removed === 1 ? "" : "s"}`)
'
fi

echo
echo "done."
echo "your usage log is still at ~/.local/state/jevlin/ — delete it by hand if you want:"
echo "  rm -rf ~/.local/state/jevlin"
echo "your API key, if you put it in a file, is still at ~/.config/jevlin/env"
