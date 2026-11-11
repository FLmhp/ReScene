#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
RUN_PREFIX=${1:-academic-v1}
RESUME=${2:-false}
MANIFEST=${3:-academic-v1.json}
PROFILES=${4:-fast,balanced,quality}
CANDIDATES=${5:-candidates-v1.json}
[[ "$RUN_PREFIX" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid run prefix" >&2; exit 2; }
[[ "$MANIFEST" =~ ^[A-Za-z0-9._-]+\.json$ ]] || { echo "Invalid manifest" >&2; exit 2; }
[[ "$PROFILES" =~ ^(fast|balanced|quality)(,(fast|balanced|quality))*$ ]] || { echo "Invalid profiles" >&2; exit 2; }
[[ "$CANDIDATES" =~ ^[A-Za-z0-9._-]+\.json$ ]] || { echo "Invalid candidates" >&2; exit 2; }

output="$ROOT/calibration/$RUN_PREFIX"
mkdir -p "$output"
nohup flock -n "$ROOT/.gpu.lock" "$ROOT/scripts/run_benchmark_locked.sh" \
  "$RUN_PREFIX" "$RESUME" "$MANIFEST" "$PROFILES" "$CANDIDATES" >"$output/launcher.log" 2>&1 &
pid=$!
echo "$pid" >"$output/pid"
echo "$pid"
