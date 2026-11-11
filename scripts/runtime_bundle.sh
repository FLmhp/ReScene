#!/usr/bin/env bash
set -euo pipefail

action=${1:?Usage: runtime_bundle.sh pack DIRECTORY | install BUNDLE DIRECTORY}
bundle=$(realpath -m "${2:?Bundle directory required}")

if [[ $action == pack ]]; then
  root=${RESCENE_ROOT:-/root/ReScene}
  data=${RESCENE_DATA_ROOT:-/root/autodl-tmp/rescene}
  python_home=$(dirname "$(dirname "$(readlink -f "$root/.venv/bin/python")")")
  mkdir "$bundle"
  tar -cf "$bundle/source.tar" -C "$root" --exclude='__pycache__' \
    src configs scripts/smoke_gpu.py scripts/runtime_bundle.sh scripts/transfer_runtime_bundle.py \
    workerctl pyproject.toml VERSION environment-lock.json
  tar -cf - --transform "s|^$(basename "$python_home")|python|" \
    --exclude='__pycache__' --exclude='*/.git' --exclude='*/.bootstrap' \
    -C "$data" runtime cache/models cache/torch cache/wheels \
    -C "$(dirname "$python_home")" "$(basename "$python_home")" |
    gzip -1 >"$bundle/runtime.tar.gz"
  cp "$root/environment-lock.json" "$bundle/environment-lock.json"
  (cd "$bundle"; sha256sum source.tar runtime.tar.gz environment-lock.json >checksums.sha256)
  du -sh "$bundle"
elif [[ $action == install ]]; then
  destination=$(realpath -m "${3:?New destination required}")
  test ! -e "$destination"
  (cd "$bundle"; sha256sum --strict --check checksums.sha256)
  mkdir -p "$destination/ReScene"
  tar -xzf "$bundle/runtime.tar.gz" -C "$destination" --no-same-owner
  root=$destination/ReScene
  tar -xf "$bundle/source.tar" -C "$root" --no-same-owner
  for entry in .venv:runtime/.venv .tools:runtime/tools .compat:runtime/compat third_party:runtime/third_party .cache:cache; do
    ln -s "$destination/${entry#*:}" "$root/${entry%%:*}"
  done
  ln -sfn "$destination/python/bin/python3.11" "$root/.venv/bin/python"
  sed -i "s|^home = .*|home = $destination/python/bin|" "$root/.venv/pyvenv.cfg"
  for path in "$root"/.venv/lib/python3.11/site-packages/__editable__*; do
    [[ -f "$path" ]] || continue
    sed -i "s|/root/autodl-tmp/rescene|$destination|g; s|/root/ReScene|$root|g" "$path"
  done
  for path in "$root"/.venv/bin/*; do
    [[ -f "$path" && ! -L "$path" ]] || continue
    if head -c 2 "$path" | grep -q '^#!'; then
      sed -i "1s|/root/ReScene|$root|" "$path"
    fi
  done
  cd "$root"
  RESCENE_ROOT="$root" RESCENE_DATA_ROOT="$destination" TORCH_HOME="$destination/cache/torch" \
    ./workerctl smoke
else
  echo "Unknown runtime bundle action" >&2
  exit 2
fi
