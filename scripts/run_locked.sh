#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
DATA=${RESCENE_DATA_ROOT:-/root/autodl-tmp/rescene}
PROFILE=${1:?profile required}
INPUT=${2:?input required}
RUN_ID=${3:?run id required}
RESUME=${4:-false}

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

args=(--profile "$PROFILE" --input "$INPUT" --run-id "$RUN_ID")
[[ "$RESUME" == true ]] && args+=(--resume)
exec "$ROOT/.venv/bin/python" -m rescene run "${args[@]}"
