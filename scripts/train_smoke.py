"""Minimal single-scene GPU smoke test for a freshly synced 5090 host."""

from __future__ import annotations

import argparse
import time
from dataclasses import replace
from pathlib import Path

from rescene.config import profile_config
from rescene.pipeline import run_pipeline


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("/root/ReScene/data/golden-kitchen/images"))
    parser.add_argument("--output", type=Path, default=Path("/tmp/rescene-smoke"))
    parser.add_argument("--run-id", default="smoke-5090")
    parser.add_argument("--steps", type=int, default=100)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    run_dir = run_pipeline(
        "fast",
        args.input,
        args.run_id,
        config_override=replace(profile_config("fast"), gsplat_steps=args.steps),
        output_dir=args.output / args.run_id,
    )
    print(f"run_dir={run_dir} seconds={time.perf_counter() - started:.1f}")


if __name__ == "__main__":
    main()
