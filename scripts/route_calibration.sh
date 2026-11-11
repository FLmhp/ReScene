#!/usr/bin/env bash
# Drive the 5090 quality-first calibration round end to end.
#
# Stages run in order and are resumable: every benchmark stage passes --resume, so
# an interrupted driver continues where it stopped. `all` first waits for the GPU
# to go idle, then screens the candidate matrix, selects per-profile winners,
# validates them on the frozen frames, runs the ETH3D holdout, writes
# calibration/selection-v2.json plus configs/calibration/selected-v2.json, and
# finally scores the holdout with the official evaluator.
#
# Usage: scripts/route_calibration.sh [wait|baseline|screen|select|validate|holdout|evaluate|finalize|all]
set -euo pipefail

ROOT="${RESCENE_ROOT:-/root/ReScene}"
STAGE="${1:-all}"
cd "$ROOT"

BASELINE_PREFIX=route-baseline-v2
SCREEN_PREFIX=route-screen-v2
VALIDATION_PREFIX=route-validation-v2
HOLDOUT_PREFIX=route-holdout-v2
SCREEN_CANDIDATES=route-screen-v2.json
WINNERS_CANDIDATES=route-winners-v2.json
FROZEN_FRAMES=configs/calibration/validation-frames-v2.json
SELECTION=calibration/selection-v2.json
SELECTED=configs/calibration/selected-v2.json

wait_for_gpu() {
  echo "waiting for the production benchmark to finish"
  while pgrep -f "rescene benchmark" >/dev/null; do sleep 30; done
  echo "waiting for GPU compute processes to clear"
  while [[ -n "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits | tr -d '[:space:]')" ]]; do sleep 30; done
  echo "GPU is idle"
}

stage_baseline() {
  echo "== baseline: three repeats of each profile on golden-kitchen"
  BUDGET_HOURS=3 EXTRA_ARGS="--repeat 3" bash scripts/run_benchmark_locked.sh \
    "$BASELINE_PREFIX" true route-screen-kitchen-v2.json fast,balanced,quality route-baseline-v2.json
}

stage_screen() {
  echo "== screen: candidate matrix on golden-kitchen"
  BUDGET_HOURS=6 bash scripts/run_benchmark_locked.sh \
    "$SCREEN_PREFIX" true route-screen-kitchen-v2.json fast,balanced,quality "$SCREEN_CANDIDATES"
}

stage_select() {
  echo "== select: per-profile screen winners"
  "$ROOT/.venv/bin/python" scripts/select_route.py \
    --screen "calibration/$SCREEN_PREFIX/leaderboard.json" \
    --candidates "configs/calibration/$SCREEN_CANDIDATES" \
    --winners "configs/calibration/$WINNERS_CANDIDATES" \
    --output "calibration/selection-v2-screen.json"
}

stage_validate() {
  echo "== validate: screen winners on fern/flower/playground"
  BUDGET_HOURS=8 EXTRA_ARGS="--validation-frames $FROZEN_FRAMES" bash scripts/run_benchmark_locked.sh \
    "$VALIDATION_PREFIX" true route-validation-v2.json fast,balanced,quality "$WINNERS_CANDIDATES"
}

stage_holdout() {
  echo "== holdout: screen winners on the ETH3D courtyard/office test scenes"
  BUDGET_HOURS=4 EXTRA_ARGS="--split test --validation-frames $FROZEN_FRAMES" bash scripts/run_benchmark_locked.sh \
    "$HOLDOUT_PREFIX" true route-holdout-v2.json fast,balanced,quality "$WINNERS_CANDIDATES"
}

stage_evaluate() {
  echo "== evaluate: official ETH3D scores on the holdout runs"
  "$ROOT/.venv/bin/python" scripts/evaluate_holdout.py \
    --leaderboard "calibration/$HOLDOUT_PREFIX/leaderboard.json" \
    --evaluator ".cache/multi-view-evaluation/build/ETH3DMultiViewEvaluation" \
    --output "calibration/$HOLDOUT_PREFIX/official.json"
}

stage_finalize() {
  echo "== finalize: promote winners that pass validation and holdout"
  "$ROOT/.venv/bin/python" scripts/select_route.py \
    --screen "calibration/$SCREEN_PREFIX/leaderboard.json" \
    --candidates "configs/calibration/$SCREEN_CANDIDATES" \
    --validation "calibration/$VALIDATION_PREFIX/leaderboard.json" \
    --holdout "calibration/$HOLDOUT_PREFIX/leaderboard.json" \
    --output "$SELECTION" \
    --selected "$SELECTED" \
    --winners "configs/calibration/$WINNERS_CANDIDATES"
  echo "wrote $SELECTION and $SELECTED"
}

case "$STAGE" in
  wait) wait_for_gpu ;;
  baseline) stage_baseline ;;
  screen) stage_screen ;;
  select) stage_select ;;
  validate) stage_validate ;;
  holdout) stage_holdout ;;
  evaluate) stage_evaluate ;;
  finalize) stage_finalize ;;
  all)
    wait_for_gpu
    stage_baseline
    stage_screen
    stage_select
    stage_validate
    stage_holdout
    # Promotion depends on screen/validation/holdout metrics only, so record it
    # before the slow official scoring pass; `evaluate` can be re-run alone.
    stage_finalize
    stage_evaluate
    ;;
  *)
    echo "unknown stage: $STAGE" >&2
    exit 2
    ;;
esac
