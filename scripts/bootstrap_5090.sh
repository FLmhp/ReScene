#!/usr/bin/env bash
set -euo pipefail

ROOT=/root/ReScene
DATA=/root/autodl-tmp/rescene
[[ "$(pwd -P)" == "$ROOT" ]] || { echo "Run from $ROOT" >&2; exit 2; }
mkdir -p "$DATA"/{runtime,cache,jobs,logs,state}
for pair in ".venv:runtime/.venv" ".bootstrap:runtime/.bootstrap" ".tools:runtime/tools" ".compat:runtime/compat" ".cache:cache" "third_party:runtime/third_party"; do
  link=${pair%%:*}
  target=$DATA/${pair#*:}
  mkdir -p "$target"
  [[ -e "$link" || -L "$link" ]] || ln -s "$target" "$link"
done

system_libs=$DATA/runtime/system-libs
if [[ ! -f "$system_libs/usr/lib/x86_64-linux-gnu/libSM.so.6" ]]; then
  mkdir -p "$DATA/cache/system-libs"
  while read -r filename sha url; do
    package=$DATA/cache/system-libs/$filename
    if [[ ! -f "$package" ]] || ! echo "$sha  $package" | sha256sum --check --status; then
      curl -L --fail --retry 10 -o "$package" "$url"
    fi
    echo "$sha  $package" | sha256sum --check
    dpkg-deb -x "$package" "$system_libs"
  done <<'PACKAGES'
libsm6_1.2.3-1build2_amd64.deb e652e286a79d9e8e15189d79b290bdce20aca83651f3dfed1b9b7dc0bbf0702f https://archive.ubuntu.com/ubuntu/pool/main/libs/libsm/libsm6_1.2.3-1build2_amd64.deb
libice6_1.0.10-1build2_amd64.deb eea6d52d12ad610d70b0f70c825ed3c560dafb09f4c272e3c6b0b493d984d13f https://archive.ubuntu.com/ubuntu/pool/main/libi/libice/libice6_1.0.10-1build2_amd64.deb
PACKAGES
fi

gpu=$(nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader | head -n1)
[[ "$gpu" == *"RTX 5090"* && "$gpu" == *"12.0"* ]] || { echo "Expected RTX 5090 CC 12.0, got: $gpu" >&2; exit 3; }

export RESCENE_ROOT=$ROOT
export RESCENE_WORK_ROOT=$DATA/jobs
export RESCENE_MODEL_CACHE=$DATA/cache/models
export RESCENE_CUDA_ARCH_LIST=12.0
export RESCENE_MAX_JOBS=12
export RESCENE_BUILD_ETH3D=0
export LD_LIBRARY_PATH="$system_libs/usr/lib/x86_64-linux-gnu:$ROOT/.venv/lib/python3.11/site-packages/nvidia/cuda_runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
bash scripts/bootstrap_remote.sh
.venv/bin/python scripts/smoke_gpu.py

sha256sum environment-lock.json >environment-lock.json.sha256
echo "RTX 5090 bootstrap and smoke complete"
