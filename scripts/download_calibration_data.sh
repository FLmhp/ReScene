#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
DOWNLOADS="$ROOT/.downloads"
DATASETS="$ROOT/datasets"
mkdir -p "$DOWNLOADS" "$DATASETS/mipnerf360" "$DATASETS/eth3d" "$DATASETS/dtu"

download() {
  local url=$1
  local target=$2
  [[ -s "$target" ]] && return
  curl -L --fail --retry 20 --retry-all-errors --continue-at - -o "$target.part" "$url"
  mv "$target.part" "$target"
}

download "https://storage.googleapis.com/gresearch/refraw360/360_v2.zip" "$DOWNLOADS/360_v2.zip"
unzip -q -o "$DOWNLOADS/360_v2.zip" "bonsai/*" "garden/*" "bicycle/*" -d "$DATASETS/mipnerf360"

for scene in courtyard office playground; do
  archive="$DOWNLOADS/${scene}_dslr_undistorted.7z"
  download "https://eth3d.ethz.ch/data/${scene}_dslr_undistorted.7z" "$archive"
  mkdir -p "$DATASETS/eth3d/$scene/images"
  7z e -y -o"$DATASETS/eth3d/$scene/images" "$archive" '*.jpg' '*.JPG' >/dev/null
done

download "https://roboimagedata2.compute.dtu.dk/data/MVS/SampleSet.zip" "$DOWNLOADS/dtu-sampleset.zip"
unzip -q -o "$DOWNLOADS/dtu-sampleset.zip" -d "$DATASETS/dtu/sample"

sha256sum "$DOWNLOADS/360_v2.zip" "$DOWNLOADS"/*.7z "$DOWNLOADS/dtu-sampleset.zip" \
  >"$DOWNLOADS/SHA256SUMS"
