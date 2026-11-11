#!/usr/bin/env bash
# Download Mip-NeRF 360 and keep only the garden images.
# The upstream archive holds every scene (~12.5 GB), so this refuses to start
# unless the target disk has room for the archive plus the extracted scene.
set -euo pipefail

ROOT=${RESCENE_ROOT:-/root/ReScene}
DOWNLOADS=${MIP360_DOWNLOADS:-$ROOT/.downloads}
URL=${MIP360_URL:-https://storage.googleapis.com/gresearch/refraw360/360_v2.zip}
REQUIRED_GB=${MIP360_REQUIRED_GB:-17}
DESTINATION="$ROOT/data/mip360-garden/images"

mkdir -p "$DOWNLOADS" "$DESTINATION"
available_gb=$(df -BG --output=avail "$DOWNLOADS" | tail -n1 | tr -dc '0-9')
if (( available_gb < REQUIRED_GB )); then
  echo "need ${REQUIRED_GB}GB free under $DOWNLOADS, found ${available_gb}GB" >&2
  exit 4
fi

archive="$DOWNLOADS/360_v2.zip"
if [[ ! -s "$archive" ]]; then
  curl -L --fail --retry 20 --retry-all-errors --continue-at - -o "$archive.part" "$URL"
  mv "$archive.part" "$archive"
fi

stage="$DOWNLOADS/garden-stage"
rm -rf "$stage"
unzip -q -o "$archive" "garden/images/*" -d "$stage"
count=$(find "$stage/garden/images" -type f | wc -l)
if (( count < 185 )); then
  echo "expected at least 185 garden images, found $count" >&2
  exit 5
fi
cp -f "$stage/garden/images/"* "$DESTINATION/"
rm -rf "$stage" "$archive"
echo "garden images=$count"
