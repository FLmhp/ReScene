#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
PROFILE=${1:?profile required}
INPUT=${2:?input required}
RUN_ID=${3:?run id required}
RESUME=${4:-false}
[[ "$PROFILE" =~ ^(fast|balanced|quality)$ ]] || { echo "Invalid profile" >&2; exit 2; }
[[ "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid run id" >&2; exit 2; }

run_dir="$ROOT/runs/$RUN_ID"
mkdir -p "$run_dir"
nohup flock -n "$ROOT/.gpu.lock" "$ROOT/scripts/run_locked.sh" \
  "$PROFILE" "$INPUT" "$RUN_ID" "$RESUME" >"$run_dir/launcher.log" 2>&1 &
pid=$!
echo "$pid" >"$run_dir/pid"
echo "$pid"
