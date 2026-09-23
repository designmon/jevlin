#!/usr/bin/env bash
# Puts the machine back. Leaves ~/jev and the logs alone; delete those by hand if you want.
set -u
N="$(command -v node)"

echo "removing symlinks…"
rm -f "$HOME/.local/bin/jev"
rm -f "$HOME/.claude/skills/jevlin"
rm -f "$HOME/.codex/skills/jevlin"

echo "stripping the jevlin hooks from ~/.claude/settings.json…"
"$N" -e '
const fs=require("fs"); const p=process.env.HOME+"/.claude/settings.json";
const s=JSON.parse(fs.readFileSync(p,"utf8"));
const isJev=(g)=>(g.hooks??[]).some(h=>String(h.command??"").includes("/jev/hooks/"));
for(const ev of Object.keys(s.hooks??{})){
  s.hooks[ev]=s.hooks[ev].filter(g=>!isJev(g));
  if(!s.hooks[ev].length) delete s.hooks[ev];
}
if(s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
if(s.env) delete s.env.JEVLIN_WATCH;
s.permissions.allow=(s.permissions.allow??[]).filter(r=>r!=="Bash(jevlin *)");
fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
console.log("  settings.json cleaned");
'
echo
echo "done. ~/jev and ~/.local/state/jevlin/*.jsonl were left in place."
echo "your permission rewrite is NOT undone — restore a backup if you want that:"
ls -1 "$HOME"/.claude/settings.json.bak-* 2>/dev/null | tail -3 | sed 's/^/  /'
