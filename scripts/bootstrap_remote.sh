#!/usr/bin/env bash
set -euo pipefail

ROOT=${RESCENE_ROOT:-/home/loch/ReScene}
CUDA_ARCH=${RESCENE_CUDA_ARCH_LIST:-8.0}
MAX_JOBS=${RESCENE_MAX_JOBS:-12}
[[ "$(pwd -P)" == "$ROOT" ]] || { echo "Run from $ROOT" >&2; exit 2; }

mkdir -p .bootstrap .tools/bin .cache/{uv,torch,models/VGGT-1B} third_party data runs
export UV_CACHE_DIR="$ROOT/.cache/uv"
export UV_DEFAULT_INDEX="https://mirrors.aliyun.com/pypi/simple"
export UV_HTTP_RETRIES=10
export UV_HTTP_TIMEOUT=300
export TORCH_HOME="$ROOT/.cache/torch"
export PIP_CACHE_DIR="$ROOT/.cache/pip"

if [[ ! -x .bootstrap/bin/uv ]]; then
  curl --proto '=https' --tlsv1.2 -LsSf https://astral.sh/uv/install.sh | \
    env UV_INSTALL_DIR="$ROOT/.bootstrap/bin" UV_NO_MODIFY_PATH=1 sh
fi
.bootstrap/bin/uv python install 3.11
if [[ ! -x .venv/bin/python ]]; then
  .bootstrap/bin/uv venv --python 3.11 .venv
fi

source_at() {
  local name=$1 repository=$2 revision=$3 target="third_party/$1"
  if [[ -f "$target/.revision" ]] && [[ "$(<"$target/.revision")" == "$revision" ]]; then
    return
  fi
  if [[ -d "$target/.git" ]] && [[ "$(git -C "$target" rev-parse HEAD 2>/dev/null || true)" == "$revision" ]] && [[ -f "$target/pyproject.toml" ]]; then
    printf '%s\n' "$revision" >"$target/.revision"
    return
  fi
  local staging archive previous
  staging=$(mktemp -d "$ROOT/third_party/.${name}.XXXXXX")
  archive="$ROOT/.cache/${name}-${revision}.tar.gz"
  if ! tar -tzf "$archive" >/dev/null 2>&1; then
    curl -L --fail --retry 3 -o "$archive" "https://codeload.github.com/${repository}/tar.gz/${revision}"
  fi
  tar -xzf "$archive" --strip-components=1 -C "$staging"
  if [[ -e "$target" ]]; then
    previous="$ROOT/.cache/previous-${name}-$(date +%s)"
    mv "$target" "$previous"
    echo "Moved incomplete $name source to $previous"
  fi
  mv "$staging" "$target"
  printf '%s\n' "$revision" >"$target/.revision"
}

source_at vggt facebookresearch/vggt a288dd0f14786c93483e45524328726ab7b1b4ce
source_at gsplat nerfstudio-project/gsplat 512d366b67073d77ca099ede742683c165dfc23b
source_at spz nianticlabs/spz affd0ecea7fbb4c265ee119475af7ee5b2997482
source_at lightglue jytime/LightGlue 2f23ca2ea9638cecad7f7220795210fc6b8353c3
source_at glm g-truc/glm 2d4c4b4dd31fde06cfffad7915c2b3006402322f
source_at dinov2 facebookresearch/dinov2 7764ea0f912e53c92e82eb78a2a1631e92725fc8
source_at multi-view-evaluation ETH3D/multi-view-evaluation 0daa4f4de036d47d37a6ba054c51fd66642ef896
source_at nerfview nerfstudio-project/nerfview 4538024fe0d15fd1a0e4d760f3695fc44ca72787
if [[ ! -f third_party/spz/cli_tools/src/ply_to_spz.cpp ]]; then
  tar -xzf "$ROOT/.cache/spz-affd0ecea7fbb4c265ee119475af7ee5b2997482.tar.gz" \
    --strip-components=1 -C third_party/spz \
    spz-affd0ecea7fbb4c265ee119475af7ee5b2997482/cli_tools
fi
if [[ ! -f third_party/gsplat/config.yaml ]]; then
  curl -L --fail --retry 3 -o third_party/gsplat/config.yaml \
    https://raw.githubusercontent.com/nerfstudio-project/gsplat/512d366b67073d77ca099ede742683c165dfc23b/config.yaml
fi
glm_target=third_party/gsplat/gsplat/cuda/csrc/third_party/glm
if [[ ! -f "$glm_target/glm/gtc/type_ptr.hpp" ]]; then
  if [[ -e "$glm_target" ]] || [[ -L "$glm_target" ]]; then
    mv "$glm_target" "$ROOT/.cache/previous-gsplat-glm-$(date +%s)"
  fi
  mkdir -p "$(dirname "$glm_target")"
  ln -s "$ROOT/third_party/glm" "$glm_target"
fi

UV=.bootstrap/bin/uv
PY=.venv/bin/python
if ! "$PY" -c 'import torch; assert torch.__version__.split("+")[0] == "2.12.0"; assert torch.version.cuda == "13.0"' 2>/dev/null; then
  $UV pip install --python "$PY" torch==2.12.0 torchvision==0.27.0 --index-url https://download.pytorch.org/whl/cu130
fi
alexnet="$TORCH_HOME/hub/checkpoints/alexnet-owt-7be5be79.pth"
mkdir -p "$(dirname "$alexnet")"
if [[ ! -f "$alexnet" ]] || [[ "$(sha256sum "$alexnet" | cut -c1-8)" != 7be5be79 ]]; then
  curl -L --fail --retry 30 --retry-all-errors --continue-at - -o "$alexnet" \
    https://download.pytorch.org/models/alexnet-owt-7be5be79.pth
fi
dinov2="$TORCH_HOME/hub/checkpoints/dinov2_vitb14_reg4_pretrain.pth"
dinov2_sha=73182a088cf94833c94b1666d1c99e02fe87e2007bff57b564fb6206e25dba71
if [[ ! -s "$dinov2" ]]; then
  curl -L --fail --retry 30 --retry-all-errors --continue-at - -o "$dinov2.part" \
    https://hf-mirror.com/cubert-gmbh/dinov2/resolve/main/dinov2_vitb14_reg4_pretrain.pth
  mv "$dinov2.part" "$dinov2"
fi
echo "$dinov2_sha  $dinov2" | sha256sum --check
sha256sum "$dinov2" >"$dinov2.sha256"
tracker="$ROOT/.cache/models/VGGSfM/vggsfm_v2_tracker.pt"
tracker_sha=451f1d218be1ef661c81d6254cbc633a5190e7d6069fe51621cc29ba5d90a404
if [[ ! -s "$tracker" ]]; then
  mkdir -p "$(dirname "$tracker")"
  curl -L --fail --retry 30 --retry-all-errors --continue-at - -o "$tracker.part" \
    https://hf-mirror.com/facebook/VGGSfM/resolve/main/vggsfm_v2_tracker.pt
  mv "$tracker.part" "$tracker"
fi
echo "$tracker_sha  $tracker" | sha256sum --check
sha256sum "$tracker" >"$tracker.sha256"

prefetch_wheel() {
  local package=$1 version=$2 url filename
  read -r url filename < <("$PY" scripts/wheel_url.py "$package" "$version")
  mkdir -p "$ROOT/.cache/wheels"
  wheel="$ROOT/.cache/wheels/$filename"
  if ! "$PY" -c 'import sys, zipfile; assert zipfile.ZipFile(sys.argv[1]).testzip() is None' "$wheel" 2>/dev/null; then
    curl -L --fail --retry 20 --retry-all-errors --continue-at - -o "$wheel" "$url"
  fi
  $UV pip install --python "$PY" --no-deps "$wheel"
}

prefetch_wheel pycolmap-cuda12 4.2.1
prefetch_wheel nvidia-curand-cu12 10.3.10.19
prefetch_wheel nvidia-cuda-runtime-cu12 12.9.79
prefetch_wheel scipy 1.17.1
prefetch_wheel pyceres 2.6

$UV pip install --python "$PY" -e '.[dev,worker]' safetensors pycolmap-cuda12 pyceres trimesh scipy cmake ninja
$UV pip install --python "$PY" -e third_party/vggt
$UV pip install --python "$PY" -e third_party/lightglue
$UV pip install --python "$PY" \
  kornia==0.8.2 hydra-core==1.3.2 omegaconf==2.3.0 \
  onnxruntime==1.23.2 pydantic==2.10.6
if ! PYTHONPATH="$ROOT/.compat/pycolmap310" "$PY" -c 'import pycolmap; assert pycolmap.__version__ == "3.10.0"' 2>/dev/null; then
  mkdir -p "$ROOT/.compat/pycolmap310"
  $UV pip install --python "$PY" --target "$ROOT/.compat/pycolmap310" --no-deps pycolmap==3.10.0
fi
$UV pip install --python "$PY" \
  nvidia-cuda-nvcc==13.0.88 nvidia-cuda-cccl==13.0.85 \
  nvidia-cuda-crt==13.0.88 nvidia-nvvm==13.0.88
CUDA_HOME="$ROOT/.venv/lib/python3.11/site-packages/nvidia/cu13"
[[ -e "$CUDA_HOME/lib64" ]] || ln -s lib "$CUDA_HOME/lib64"
[[ -e "$CUDA_HOME/lib/libcudart.so" ]] || ln -s libcudart.so.13 "$CUDA_HOME/lib/libcudart.so"
for header in cuda cub thrust; do
  [[ -e "$CUDA_HOME/include/$header" ]] || ln -s "cccl/$header" "$CUDA_HOME/include/$header"
done
export CUDA_HOME
export PATH="$CUDA_HOME/bin:$PATH"
if [[ ! -f .bootstrap/gsplat-arch ]] || [[ "$(<.bootstrap/gsplat-arch)" != "$CUDA_ARCH" ]] || \
   ! "$PY" -c 'import gsplat' 2>/dev/null; then
  [[ "$(pwd -P)" == "$ROOT" ]] || exit 2
  rm -rf third_party/gsplat/build
  BUILD_EXPERIMENTAL=0 BUILD_3DGS=1 BUILD_2DGS=0 BUILD_3DGUT=0 \
    CUDA_HOME="$CUDA_HOME" TORCH_CUDA_ARCH_LIST="$CUDA_ARCH" MAX_JOBS="$MAX_JOBS" \
    $UV pip install --python "$PY" --no-build-isolation -e third_party/gsplat
  printf '%s\n' "$CUDA_ARCH" >.bootstrap/gsplat-arch
fi
$UV pip install --python "$PY" \
  viser 'imageio[ffmpeg]' tqdm torchmetrics==1.8.2 opencv-python-headless \
  'tyro>=0.8.8,!=1.0.9,!=1.0.10' piexif tensorboard tensorly pyyaml \
  matplotlib scikit-learn splines
$UV pip install --python "$PY" -e third_party/nerfview
CMAKE_BUILD_PARALLEL_LEVEL=12 $UV pip install --python "$PY" third_party/spz

eth3d_evaluator=third_party/multi-view-evaluation/build/ETH3DMultiViewEvaluation
if [[ "${RESCENE_BUILD_ETH3D:-1}" == 1 ]] && [[ ! -x .tools/bin/micromamba ]]; then
  micromamba_archive="$ROOT/.cache/micromamba-linux-64-2.10.0.tar.bz2"
  curl -L --fail --retry 20 --retry-all-errors -o "$micromamba_archive" \
    https://micro.mamba.pm/api/micromamba/linux-64/2.10.0
  echo "9a97976244929bbae28fb1fae504e74a3e7e6d1932870e3a03321f01b7fbd07b  $micromamba_archive" | \
    sha256sum --check
  tar -xjf "$micromamba_archive" -C .tools bin/micromamba
fi
if [[ "${RESCENE_BUILD_ETH3D:-1}" == 1 ]] && [[ ! -x "$eth3d_evaluator" ]]; then
  sed -i 's/-std=c++11/-std=c++17/' third_party/multi-view-evaluation/CMakeLists.txt
  .tools/bin/micromamba create -y -r .tools/mamba-root -p .tools/eth3d-eval-env \
    -f third_party/eth3d-evaluator-conda-lock.txt
  .tools/bin/micromamba run -r .tools/mamba-root -p .tools/eth3d-eval-env cmake \
    -S third_party/multi-view-evaluation -B third_party/multi-view-evaluation/build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  .tools/bin/micromamba run -r .tools/mamba-root -p .tools/eth3d-eval-env cmake \
    --build third_party/multi-view-evaluation/build -j 12
fi
if [[ -x "$eth3d_evaluator" ]]; then
  sha256sum "$eth3d_evaluator" >third_party/eth3d-evaluator-binary.sha256
fi

"$PY" - <<'PY'
import importlib.metadata as metadata
import hashlib
import json
import subprocess
from pathlib import Path

import torch

root = Path.cwd()
def digest(path: Path):
    if not path.is_file():
        return None
    hasher = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()

model = next((path for path in (
    root / '.cache/models/VGGT-1B/model.safetensors',
    root / '.cache/models/VGGT-1B/model.pt',
) if path.is_file()), None)
driver = subprocess.check_output(
    ['nvidia-smi', '--query-gpu=driver_version', '--format=csv,noheader'], text=True
).splitlines()[0].strip()
payload = {
    'packages': sorted({f'{item.metadata["Name"]}=={item.version}' for item in metadata.distributions()}),
    'git_revisions': {
        name: (root / 'third_party' / name / '.revision').read_text().strip()
        for name in ('vggt', 'gsplat', 'spz', 'lightglue', 'glm', 'dinov2', 'multi-view-evaluation', 'nerfview')
    },
    'compat_packages': {'pycolmap': '3.10.0'},
    'cuda_arch_list': (root / '.bootstrap' / 'gsplat-arch').read_text().strip(),
    'gpu': {
        'name': torch.cuda.get_device_name(0),
        'compute_capability': '.'.join(map(str, torch.cuda.get_device_capability(0))),
        'driver': driver,
        'torch': torch.__version__,
        'cuda_runtime': torch.version.cuda,
    },
    'artifacts': {
        'vggt_weight_sha256': digest(model) if model else None,
        'gsplat_extension_sha256': digest(root / 'third_party/gsplat/gsplat/csrc.so'),
        'spz_extension_sha256': digest(root / '.venv/lib/python3.11/site-packages/spz/spz.cpython-311-x86_64-linux-gnu.so'),
    },
}
(root / 'environment-lock.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY

echo "Bootstrap complete. Upload VGGT weights with: scripts/remote.ps1 model -Remote <ssh-host> -Root <remote-path> -ModelPath <path>"
