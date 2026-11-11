"""Convert a gsplat PLY to Niantic SPZ."""

from __future__ import annotations

import argparse
from pathlib import Path


def convert(source: Path, destination: Path) -> None:
    import spz

    unpack = spz.UnpackOptions()
    unpack.to_coord = spz.CoordinateSystem.RUB
    cloud = spz.load_splat_from_ply(str(source), unpack)
    pack = spz.PackOptions()
    pack.from_coord = spz.CoordinateSystem.RUB
    destination.parent.mkdir(parents=True, exist_ok=True)
    spz.save_spz(cloud, pack, str(destination))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    convert(args.source, args.destination)


if __name__ == "__main__":
    main()
