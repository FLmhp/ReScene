#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
REVISION=a288dd0f14786c93483e45524328726ab7b1b4ce
DESTINATION="$ROOT/data/golden-kitchen"
mkdir -p "$DESTINATION/images"

for index in {00..07}; do
  target="$DESTINATION/images/$index.png"
  [[ -s "$target" ]] && continue
  curl -L --fail --retry 20 --retry-all-errors --continue-at - \
    -o "$target.part" \
    "https://raw.githubusercontent.com/facebookresearch/vggt/$REVISION/examples/kitchen/images/$index.png"
  mv "$target.part" "$target"
done

sha256sum "$DESTINATION"/images/*.png >"$DESTINATION/SHA256SUMS"
printf '%s\n' \
  "source=https://github.com/facebookresearch/vggt/tree/$REVISION/examples/kitchen" \
  "revision=$REVISION" \
  >"$DESTINATION/SOURCE.txt"
