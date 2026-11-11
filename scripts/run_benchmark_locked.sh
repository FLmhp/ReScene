#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
DATA=${RESCENE_DATA_ROOT:-/root/autodl-tmp/rescene}
RUN_PREFIX=${1:-academic-v1}
RESUME=${2:-false}
MANIFEST=${3:-academic-v1.json}
PROFILES=${4:-fast,balanced,quality}
CANDIDATES=${5:-candidates-v1.json}
BUDGET_HOURS=${BUDGET_HOURS:-24}
IFS=, read -r -a profile_args <<<"$PROFILES"

active=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits | sed '/^[[:space:]]*$/d')
if [[ -n "$active" ]]; then
  echo "Refusing to start: GPU compute processes already active: $active" >&2
  exit 20
fi

export RESCENE_ROOT="$ROOT"
export CUDA_VISIBLE_DEVICES=0
export OMP_NUM_THREADS=12
export MKL_NUM_THREADS=12
export TORCH_HOME="$ROOT/.cache/torch"
export HF_HOME="$ROOT/.cache/huggingface"
export HF_HUB_OFFLINE=1
export LD_LIBRARY_PATH="$DATA/runtime/system-libs/usr/lib/x86_64-linux-gnu:$ROOT/.venv/lib/python3.11/site-packages/nvidia/cuda_runtime/lib:$ROOT/.venv/lib/python3.11/site-packages/nvidia/curand/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

args=(
  --manifest "$ROOT/configs/datasets/$MANIFEST"
  --candidates "$ROOT/configs/calibration/$CANDIDATES"
  --profiles "${profile_args[@]}"
  --run-prefix "$RUN_PREFIX"
  --budget-hours "$BUDGET_HOURS"
)
[[ "$RESUME" == true ]] && args+=(--resume)
# shellcheck disable=SC2206  # intentional word splitting of the extra flag string
[[ -n "${EXTRA_ARGS:-}" ]] && args+=($EXTRA_ARGS)
exec "$ROOT/.venv/bin/python" -m rescene benchmark "${args[@]}"
