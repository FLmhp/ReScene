#!/usr/bin/env bash
set -euo pipefail

worker=/root/ReScene/workerctl
lock=/root/ReScene/.gpu.lock
state=/root/autodl-tmp/rescene/state
source="${RESCENE_EXPERIMENT_SOURCE:?Use an isolated experiment source snapshot}"
work="${RESCENE_DELIVERY_ROOT:?Set the experiment working directory}"
archive="${RESCENE_EXPERIMENT_ARCHIVE:?Set the experiment archive}"
[[ "$source" == /root/autodl-tmp/rescene/large-scenes/* && "$archive" == /root/autodl-fs/rescene/experiments/* ]]
mountpoint -q /root/autodl-fs

if [[ ${1:-} == --locked ]]; then
    shift
    [[ -z $(nvidia-smi --query-compute-apps=pid --format=csv,noheader) ]]
    "$worker" stop
    export PYTHONPATH="$source/src" OMP_NUM_THREADS=12 OPENBLAS_NUM_THREADS=12 MKL_NUM_THREADS=12
    export TMPDIR="$work/tmp"
    mkdir -p "$TMPDIR"
    taskset -c 0-11 "$source/.venv/bin/python" -u "$source/scripts/quality_study.py" --archive "$archive" "$@"
    exit
fi

status="$("$worker" status)"
[[ "$status" == *'running'*'drain=no'* ]]
restore() {
    code=$?
    trap - EXIT
    if "$worker" status | grep -q 'running'; then
        # This launcher owns the drain flag after checking that the worker was accepting jobs.
        rm -f -- "$state/drain"
    elif flock -n "$lock" true && [[ -z $(nvidia-smi --query-compute-apps=pid --format=csv,noheader) ]]; then
        "$worker" start
        "$worker" status
    else
        echo 'GPU lock or compute process still present; worker restoration requires inspection' >&2
        code=19
    fi
    exit "$code"
}
trap restore EXIT
"$worker" drain
flock --close -w 600 "$lock" bash "$source/scripts/run_quality_study.sh" --locked "$@"
