#!/usr/bin/env bash
# Build the official ETH3D multi-view evaluator used by
# `rescene evaluate --official-evaluator`.
#
# The tool scores an aligned reconstruction PLY against the dataset's
# scan_alignment.mlp. It needs Boost, Eigen3, PCL and OpenMP, and is Linux
# x86-64 only, so it is built on the worker host.
set -euo pipefail

CACHE_ROOT="${CACHE_ROOT:-/root/ReScene/.cache}"
TOOLS_DIR="$CACHE_ROOT/multi-view-evaluation"
EVALUATOR="$TOOLS_DIR/build/ETH3DMultiViewEvaluation"

if [[ -x "$EVALUATOR" ]]; then
  echo "evaluator already built: $EVALUATOR"
  exit 0
fi

if ! command -v cmake >/dev/null || ! command -v g++ >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cmake build-essential
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libboost-all-dev libeigen3-dev libpcl-dev

mkdir -p "$CACHE_ROOT"
if [[ ! -d "$TOOLS_DIR/.git" ]]; then
  rm -rf "$TOOLS_DIR"
  git clone --depth 1 https://github.com/ETH3D/multi-view-evaluation.git "$TOOLS_DIR"
fi

# Upstream pins "-std=c++11" in add_definitions, but PCL >= 1.10 refuses to
# compile below C++14, so raise the standard before configuring.
sed -i 's/-std=c++11/-std=c++17/' "$TOOLS_DIR/CMakeLists.txt"

cmake -S "$TOOLS_DIR" -B "$TOOLS_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$TOOLS_DIR/build" --target ETH3DMultiViewEvaluation -j "$(nproc)"
echo "evaluator built: $EVALUATOR"
