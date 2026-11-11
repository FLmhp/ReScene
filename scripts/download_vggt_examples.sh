#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
REVISION=a288dd0f14786c93483e45524328726ab7b1b4ce

download_scene() {
  local source_name=$1
  local destination_name=$2
  local last_index=$3
  local width=$4
  local destination="$ROOT/data/$destination_name/images"
  mkdir -p "$destination"
  for number in $(seq 0 "$last_index"); do
    printf -v index "%0${width}d" "$number"
    target="$destination/$index.png"
    [[ -s "$target" ]] && continue
    (
      curl -L --fail --retry 20 --retry-all-errors \
        -o "$target.part" \
        "https://raw.githubusercontent.com/facebookresearch/vggt/$REVISION/examples/$source_name/images/$index.png"
      mv "$target.part" "$target"
    ) &
    while (( $(jobs -rp | wc -l) >= 8 )); do wait -n; done
  done
  wait
  sha256sum "$destination"/*.png >"$ROOT/data/$destination_name/SHA256SUMS"
  printf 'source=https://github.com/facebookresearch/vggt/tree/%s/examples/%s\nrevision=%s\n' \
    "$REVISION" "$source_name" "$REVISION" >"$ROOT/data/$destination_name/SOURCE.txt"
}

download_scene kitchen golden-kitchen 24 2
download_scene llff_fern vggt-fern 19 3
download_scene llff_flower vggt-flower 24 3
