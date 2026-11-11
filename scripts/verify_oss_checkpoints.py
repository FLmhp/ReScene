"""Verify that published stage archives contain reloadable Gaussian checkpoints."""

from __future__ import annotations

import json
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

import torch


def main() -> None:
    scratch = Path(sys.argv[1])
    for name, url in json.load(sys.stdin).items():
        with tempfile.TemporaryFile(dir=scratch) as archive:
            with urllib.request.urlopen(url, timeout=60) as response:
                shutil.copyfileobj(response, archive, 4 * 1024**2)
            archive.seek(0)
            with tarfile.open(fileobj=archive, mode="r:gz") as stage:
                candidates = []
                for member in stage.getmembers():
                    match = re.search(r"/ckpt_(\d+)_rank0\.pt$", member.name)
                    if match and member.isfile():
                        candidates.append((int(match.group(1)), member))
                step, member = max(candidates, key=lambda pair: pair[0])
                source = stage.extractfile(member)
                assert source is not None
                with source, tempfile.TemporaryFile(dir=scratch) as checkpoint:
                    shutil.copyfileobj(source, checkpoint, 4 * 1024**2)
                    checkpoint.seek(0)
                    payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
            means = payload["splats"]["means"]
            assert means.ndim == 2 and means.shape[1] == 3 and means.shape[0] > 0
            assert torch.isfinite(means).all()
            print(f"{name}: step={step}, gaussians={means.shape[0]}", flush=True)


if __name__ == "__main__":
    main()
