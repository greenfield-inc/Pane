#!/usr/bin/env bash
# THROWAWAY (P12 evidence; reverted before review). Runs the previous type
# checkers and bun check on every project, on a clean tree and then with a type
# error seeded into every tracked source file, and diffs their diagnostics.
#   scripts/typecheck-side-by-side.sh <out dir>
set -uo pipefail
out="${1:?out dir}"
mkdir -p "$out"
ts7="node node_modules/@typescript/native/bin/tsc"
ts5main="node main/node_modules/typescript/bin/tsc"
ts5front="node frontend/node_modules/typescript/bin/tsc"
ts5runpane="node packages/runpane/node_modules/typescript/bin/tsc"
bun="node_modules/.bin/bun"

# project | previous checker and config (as pnpm typecheck:tsc runs it) | config bun checks
projects=(
  "frontend|$ts7 -p frontend/tsconfig.json|frontend/tsconfig.json"
  "frontend-node|$ts7 -p frontend/tsconfig.node.json|frontend/tsconfig.node.json"
  "main|$ts5main -p main/tsconfig.json|main/tsconfig.check.json"
  "runpane|$ts5runpane -p packages/runpane/tsconfig.json|packages/runpane/tsconfig.check.json"
  "glasses|$ts7 -p glasses/tsconfig.json|glasses/tsconfig.json"
  "mobile|$ts7 -p mobile/tsconfig.json|mobile/tsconfig.json"
  "native|$ts7 -p native/tsconfig.json|native/tsconfig.json"
  "native-terminal-web|$ts7 -p native/terminal-web/tsconfig.json|native/terminal-web/tsconfig.json"
  "renderer-tests|$ts5front -p tests/renderer/tsconfig.json|tests/renderer/tsconfig.json"
)

# Keeps diagnostic lines (and their indented continuations); drops summaries.
# bun's per-file count table ("  3  path:line") is a summary too.
diags() { grep -E '^(\S.*\([0-9]+,[0-9]+\): error TS[0-9]+:|\S.*: error TS[0-9]+:|  )' | grep -vE '^ +[0-9]+ +\S+:[0-9]+$' | sed -E 's/[[:space:]]+$//' || true; }

compare() {
  local phase="$1" dir="$out/$1"
  mkdir -p "$dir"
  local total_old=0 total_bun=0 total_ts7=0
  printf '\n## %s\n\n| project | previous | TS7 tsc, same config as bun | bun check | previous vs bun | TS7 vs bun |\n|---|---|---|---|---|---|\n' "$phase"
  for row in "${projects[@]}"; do
    IFS='|' read -r name old cfg <<<"$row"
    $old --noEmit --pretty false 2>&1 | diags >"$dir/$name.old"
    $ts7 --noEmit --pretty false -p "$cfg" 2>&1 | diags >"$dir/$name.ts7"
    $bun check --no-script --no-pretty --all -p "$cfg" 2>&1 | diags >"$dir/$name.bun"
    local o b t d1 d2
    o=$(grep -c ': error TS' "$dir/$name.old"); b=$(grep -c ': error TS' "$dir/$name.bun"); t=$(grep -c ': error TS' "$dir/$name.ts7")
    sort "$dir/$name.old" >"$dir/$name.old.sorted"; sort "$dir/$name.bun" >"$dir/$name.bun.sorted"; sort "$dir/$name.ts7" >"$dir/$name.ts7.sorted"
    d1=$(diff "$dir/$name.old.sorted" "$dir/$name.bun.sorted" | grep -c '^[<>]'); d2=$(diff "$dir/$name.ts7.sorted" "$dir/$name.bun.sorted" | grep -c '^[<>]')
    total_old=$((total_old + o)); total_bun=$((total_bun + b)); total_ts7=$((total_ts7 + t))
    printf '| %s | %s | %s | %s | %s lines differ | %s lines differ |\n' "$name" "$o" "$t" "$b" "$d1" "$d2"
  done
  printf '| **total** | %s | %s | %s | | |\n' "$total_old" "$total_ts7" "$total_bun"
  # The combined command CI runs, against the per-project union.
  $bun check --no-script --no-pretty --all -b 2>&1 | diags | sort >"$dir/combined.bun.sorted"
  cat "$dir"/*.bun | sort >"$dir/union.bun.sorted"
  printf '\npnpm typecheck (bun check -b) vs per-project bun union: %s lines differ\n' "$(diff "$dir/union.bun.sorted" "$dir/combined.bun.sorted" | grep -c '^[<>]')"
  for row in "${projects[@]}"; do
    IFS='|' read -r name _ _ <<<"$row"
    if ! diff -q "$dir/$name.old.sorted" "$dir/$name.bun.sorted" >/dev/null; then
      printf '\n### %s: previous (<) vs bun (>), first 40 lines\n```\n' "$name"; diff "$dir/$name.old.sorted" "$dir/$name.bun.sorted" | grep '^[<>]' | head -40; printf '```\n'
    fi
    if ! diff -q "$dir/$name.ts7.sorted" "$dir/$name.bun.sorted" >/dev/null; then
      printf '\n### %s: TS7 tsc (<) vs bun (>), first 40 lines\n```\n' "$name"; diff "$dir/$name.ts7.sorted" "$dir/$name.bun.sorted" | grep '^[<>]' | head -40; printf '```\n'
    fi
  done
}

compare clean

# Seed: one error appended to every tracked .ts/.tsx source file (not .d.ts),
# and a mix of error kinds in one file per Node and browser project.
git ls-files 'frontend/*.ts' 'frontend/*.tsx' 'main/*.ts' 'shared/*.ts' 'shared/*.tsx' 'packages/runpane/*.ts' \
  'glasses/*.ts' 'mobile/*.ts' 'native/*.ts' 'native/*.tsx' 'tests/renderer/*.ts' \
  | grep -v '\.d\.ts$' >"$out/seeded-files.txt"
while read -r f; do printf '\n;{ const __seededError: number = "x"; void __seededError; }\n' >>"$f"; done <"$out/seeded-files.txt"
mix='
import { missing as __missing } from "__no_such_module__";
void __missing;
{ const __wrongArgs = parseInt(); void __wrongArgs; }
{ const __excess: { a: number } = { a: 1, b: 2 }; void __excess; }
// @ts-expect-error
{ const __unused = 1; void __unused; }
export function __implicitAny(x) { return x; }
export function __noReturn(): number { if (Math.random() > 0.5) return 1; }
{ const __unknownProp = ({}).foo; void __unknownProp; }
'
for f in frontend/src/App.tsx main/src/index.ts packages/runpane/src/cli.ts native/src/auth/computers.ts; do [ -f "$f" ] && printf '%s' "$mix" >>"$f" && echo "mixed: $f" >>"$out/seeded-files.txt"; done
echo "seeded $(grep -vc '^mixed:' "$out/seeded-files.txt") files"
compare seeded
git checkout -- . >/dev/null
