#!/usr/bin/env bash
# End-to-end CLI tests against a mock Jev. No API key, no network, no cost.
set -u
cd "$(dirname "$0")/.."
node scripts/mock-jev.mjs >/dev/null 2>&1 & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
export JEV_BASE_URL="http://127.0.0.1:8896" JEV_API_KEY=test JEV_NO_LOG=1
fail=0

# NOTE: never pipe into this function — a pipeline runs it in a subshell and `fail=1`
# would be lost, so the suite would report success while printing failures.
t() { # t <name> <expected-exit> <stdin> <cmd...>
  local name=$1 want=$2 input=$3; shift 3
  printf '%s' "$input" > /tmp/jev-t-in.txt
  "$@" < /tmp/jev-t-in.txt > /tmp/jev-t-out.txt 2>/tmp/jev-t-err.txt
  local got=$?
  if [ "$got" = "$want" ]; then echo "  ok    $name"
  else echo "  FAIL  $name (exit $got, wanted $want): $(head -1 /tmp/jev-t-err.txt)"; fail=1; fi
}

echo "CLI end-to-end (mock endpoint, no key, no network):"
seq 1 400 > /tmp/jev-400.txt
node jev.mjs filter "this number is even" --all --scores < /tmp/jev-400.txt > /tmp/acc.txt 2>/dev/null
n=$(node -e 'const L=require("fs").readFileSync("/tmp/acc.txt","utf8").trim().split("\n");console.log(L.filter(l=>{const[p,v]=l.split("\t");return (Number(v)%2===0)===(Number(p)>=0.5)}).length+"/"+L.length)')
if [ "$n" = "400/400" ]; then echo "  ok    400 candidates over 3 chunks, every answer mapped correctly"
else echo "  FAIL  accuracy $n"; fail=1; fi

t "exit 0 when something qualifies"   0 '2
4
6
' node jev.mjs filter "even" --top 1
t "exit 1 when nothing qualifies"     1 '3
5
' node jev.mjs filter "even" --min 0.9
t "exit 2 on a bad flag value"        2 'a
b
' node jev.mjs filter q --top abc
t "exit 2 on an unknown flag"         2 'a
b
' node jev.mjs filter q --tpo 5
t "exit 2 on empty stdin"             2 '' node jev.mjs filter q
t "ask says yes"                      0 '2' node jev.mjs ask "even"
t "ask says no"                       1 '3' node jev.mjs ask "even"
t "exit 2 over --max-candidates"      2 "$(seq 1 5000)" node jev.mjs filter q

JEV_BASE_URL=http://127.0.0.1:9 t "exit 3 when the endpoint is unreachable" 3 'x' node jev.mjs filter q
if [ ! -s /tmp/jev-t-out.txt ]; then echo "  ok    degraded prints nothing on stdout"
else echo "  FAIL  degraded leaked stdout"; fail=1; fi

kill $MOCK 2>/dev/null; sleep 0.3
JEV_MOCK_FAIL_AFTER=1 node scripts/mock-jev.mjs >/dev/null 2>&1 & MOCK=$!
sleep 1
seq 1 300 > /tmp/jev-300.txt
node jev.mjs filter "even" --all --timeout 2000 < /tmp/jev-300.txt > /tmp/part.txt 2>/dev/null
got=$?
if [ "$got" = 4 ] && [ "$(wc -l < /tmp/part.txt)" -gt 0 ]; then echo "  ok    exit 4 with a partial result"
else echo "  FAIL  partial (exit $got)"; fail=1; fi

echo
if [ $fail = 0 ]; then echo "CLI tests: ALL PASS"; else echo "CLI tests: FAILURES"; fi
exit $fail
