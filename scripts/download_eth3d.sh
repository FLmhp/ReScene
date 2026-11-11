#!/usr/bin/env bash
# Download ETH3D DSLR scenes (undistorted images + scan evaluation data).
# Re-runnable: archives and extracted directories are reused when present.
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
DOWNLOADS=${ETH3D_DOWNLOADS:-$ROOT/.downloads}
BASE_URL=${ETH3D_BASE_URL:-https://eth3d.ethz.ch/data}
SCENES=${*:-"playground courtyard office"}

mkdir -p "$DOWNLOADS"

download() {
  local url=$1
  local target=$2
  [[ -s "$target" ]] && return 0
  echo "downloading $url"
  curl -L --fail --retry 20 --retry-all-errors --continue-at - -o "$target.part" "$url"
  mv "$target.part" "$target"
}

extract_dirs() {
  # extract_dirs <archive> <destination> <wanted-dir>...
  local archive=$1
  local destination=$2
  shift 2
  local stage="$destination/.stage"
  rm -rf "$stage"
  mkdir -p "$stage"
  7z x -y -o"$stage" "$archive" >/dev/null
  local name found
  for name in "$@"; do
    [[ -d "$destination/$name" ]] && continue
    found=$(find "$stage" -type d -name "$name" -print -quit)
    [[ -n "$found" ]] || {
      echo "archive $archive has no $name directory" >&2
      exit 2
    }
    mv "$found" "$destination/$name"
  done
  rm -rf "$stage"
}

for scene in $SCENES; do
  destination="$ROOT/data/eth3d-$scene"
  mkdir -p "$destination"
  undistorted="$DOWNLOADS/${scene}_dslr_undistorted.7z"
  scan_eval="$DOWNLOADS/${scene}_dslr_scan_eval.7z"

  # The undistorted archive carries both the images and the reference COLMAP
  # model; the latter aligns our reconstruction into the scan frame so the
  # official evaluator produces comparable scores.
  if [[ ! -d "$destination/dslr_images_undistorted" || ! -d "$destination/dslr_calibration_undistorted" ]]; then
    download "$BASE_URL/${scene}_dslr_undistorted.7z" "$undistorted"
    extract_dirs "$undistorted" "$destination" dslr_images_undistorted dslr_calibration_undistorted
    rm -f "$undistorted"
  fi
  if [[ ! -d "$destination/dslr_scan_eval" ]]; then
    download "$BASE_URL/${scene}_dslr_scan_eval.7z" "$scan_eval"
    extract_dirs "$scan_eval" "$destination" dslr_scan_eval
    rm -f "$scan_eval"
  fi

  count=$(find "$destination/dslr_images_undistorted" -type f \( -iname '*.jpg' -o -iname '*.png' \) | wc -l)
  echo "$scene images=$count calibration=$([[ -d "$destination/dslr_calibration_undistorted" ]] && echo yes || echo no)"
  (( count > 0 )) || {
    echo "$scene produced no images" >&2
    exit 3
  }
done

find "$ROOT/data" -maxdepth 2 -name 'eth3d-*' -type d | sort
