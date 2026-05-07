#!/usr/bin/env bash
# Drive scratch/rss-repro.ts under each env scenario in one pass.
# Per-scenario stderr (human rows) and stdout (JSONL) land in scratch/results/,
# and a final summary prints the last two post-gc samples per scenario so we
# can eyeball retention before the trailing 15s sleep vs. after it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPRO="$SCRIPT_DIR/rss-repro.ts"
OUT="$SCRIPT_DIR/results"
mkdir -p "$OUT"

ARGS=(--iters=1500 --sample-every=250 --gc-every=500 --hold=8 --bytes=4000000)

# "<name>|<KEY=VAL [KEY2=VAL2 ...]>" — empty env string means stock bun.
SCENARIOS=(
  "baseline|"
  "mimalloc-purge-delay-0|MIMALLOC_PURGE_DELAY=0"
  "mi-verbose|MI_VERBOSE=1"
  "mimalloc-verbose|MIMALLOC_VERBOSE=1"
)

run_scenario() {
  local name="$1" envstr="$2"
  local log="$OUT/${name}.log"
  local jsonl="$OUT/${name}.jsonl"
  echo "==> $name (env: ${envstr:-<none>})"
  # shellcheck disable=SC2086 # intentional word-splitting on $envstr
  env $envstr bun "$REPRO" "${ARGS[@]}" >"$jsonl" 2>"$log"
  grep "post-gc" "$log" || true
  echo
}

for s in "${SCENARIOS[@]}"; do
  run_scenario "${s%%|*}" "${s#*|}"
done

echo "==> Summary: last two post-gc samples per scenario"
echo "    (line 1 = final post-GC before the 15s idle; line 2 = after it)"
for s in "${SCENARIOS[@]}"; do
  name="${s%%|*}"
  echo
  echo "[$name]"
  grep "post-gc" "$OUT/${name}.log" | tail -2
done
