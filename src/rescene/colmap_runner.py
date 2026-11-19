"""PyCOLMAP sparse and optional dense reconstruction entry point."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from time import perf_counter


def _check_shared_images(images: Path) -> None:
    from PIL import Image

    sizes = set()
    for image in sorted(images.glob("*.jpg")):
        with Image.open(image) as frame:
            sizes.add(frame.size)
    if len(sizes) != 1:
        raise ValueError("Shared camera requires normalized images with identical dimensions")


def _write_phases(scene_dir: Path, phases: dict[str, float]) -> None:
    (scene_dir / "colmap-phases.json").write_text(json.dumps(phases, indent=2) + "\n", encoding="utf-8")


def _largest_reconstruction(maps: dict[int, object]) -> object:
    if not maps:
        raise RuntimeError("COLMAP did not register a reconstruction")
    return max(maps.values(), key=lambda item: item.num_reg_images())


def _ply_vertices(path: Path) -> int | None:
    if not path.exists():
        return None
    with path.open("rb") as stream:
        for raw_line in stream:
            line = raw_line.decode("ascii", errors="ignore").strip()
            if line.startswith("element vertex "):
                return int(line.rsplit(" ", 1)[-1])
            if line == "end_header":
                break
    return None


def _relaxed_single_camera_mapping(
    pycolmap, database: Path, images: Path, sparse_work: Path, reader_options, seed: int | None
):
    database.unlink(missing_ok=True)
    shutil.rmtree(sparse_work, ignore_errors=True)
    pycolmap.extract_features(
        database,
        images,
        camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options=reader_options,
        device=pycolmap.Device.cuda,
    )
    pycolmap.match_exhaustive(database, device=pycolmap.Device.cuda, **_matching_seed(pycolmap, seed))
    options = pycolmap.IncrementalPipelineOptions()
    if seed is not None:
        options.random_seed = seed
    options.min_num_matches = 10
    options.mapper.init_min_num_inliers = 30
    options.mapper.init_min_tri_angle = 4.0
    options.mapper.init_max_error = 8.0
    options.mapper.init_max_forward_motion = 0.99
    options.mapper.abs_pose_min_num_inliers = 15
    options.mapper.abs_pose_min_inlier_ratio = 0.1
    return pycolmap.incremental_mapping(database, images, sparse_work, options=options)


def _matching_seed(pycolmap, seed: int | None) -> dict:
    if seed is None:
        return {}
    verification = pycolmap.TwoViewGeometryOptions()
    verification.ransac.random_seed = seed
    return {"verification_options": verification}


def run(
    scene_dir: Path,
    matcher: str,
    dense: bool,
    camera_model: str = "SIMPLE_RADIAL",
    mvs_max_image_size: int = 0,
    poisson_depth: int = 10,
    *,
    mapper: str = "incremental",
    matching_db: Path | None = None,
    seed: int | None = None,
    shared_camera: bool = False,
    mvs_iterations: int | None = None,
) -> None:
    import pycolmap

    images = scene_dir / "images"
    database = scene_dir / "database.db"
    sparse_work = scene_dir / "sparse-work"
    sparse = scene_dir / "sparse" / "0"
    reader_options = pycolmap.ImageReaderOptions()
    reader_options.camera_model = camera_model
    if shared_camera:
        if camera_model != "PINHOLE" or mapper != "incremental" or matching_db is not None:
            raise ValueError("Shared camera requires PINHOLE, incremental mapping and a fresh feature database")
        _check_shared_images(images)
    phases: dict[str, float] = {}
    mapping = {}
    if seed is not None:
        # The controller and its RANSAC options use signed, nonnegative seeds.
        seed %= 2**31
        pycolmap.set_random_seed(seed)
        if mapper == "incremental":
            mapping = {"options": pycolmap.IncrementalPipelineOptions(random_seed=seed)}
    verification = _matching_seed(pycolmap, seed)
    if matching_db is not None:
        if database.exists() or Path(str(matching_db) + "-wal").exists():
            raise ValueError("Matching database must be closed and the trial database must be new")
        shutil.copyfile(matching_db, database)
    else:
        phase_start = perf_counter()
        camera = {"camera_mode": pycolmap.CameraMode.SINGLE} if shared_camera else {}
        pycolmap.extract_features(
            database, images, reader_options=reader_options, device=pycolmap.Device.cuda, **camera
        )
        phases["features_seconds"] = perf_counter() - phase_start
        phase_start = perf_counter()
        if matcher == "sequential":
            pycolmap.match_sequential(database, device=pycolmap.Device.cuda, **verification)
        else:
            pycolmap.match_exhaustive(database, device=pycolmap.Device.cuda, **verification)
        phases["matching_seconds"] = perf_counter() - phase_start
    phase_start = perf_counter()
    maps = (
        pycolmap.global_mapping(database, images, sparse_work)
        if mapper == "global"
        else pycolmap.incremental_mapping(database, images, sparse_work, **mapping)
    )
    phases["mapping_seconds"] = perf_counter() - phase_start
    experimental = mapper != "incremental" or matching_db is not None or shared_camera or mvs_iterations is not None
    if not maps and matcher == "sequential" and not experimental:
        pycolmap.match_exhaustive(database, device=pycolmap.Device.cuda, **verification)
        shutil.rmtree(sparse_work, ignore_errors=True)
        maps = pycolmap.incremental_mapping(database, images, sparse_work, **mapping)
    if not maps and not experimental:
        maps = _relaxed_single_camera_mapping(pycolmap, database, images, sparse_work, reader_options, seed)
    reconstruction = _largest_reconstruction(maps)
    phase_start = perf_counter()
    pycolmap.bundle_adjustment(reconstruction)
    phases["bundle_adjustment_seconds"] = perf_counter() - phase_start
    sparse.mkdir(parents=True, exist_ok=True)
    reconstruction.write(sparse)
    shutil.rmtree(sparse_work, ignore_errors=True)
    if dense:
        phases.update(
            _run_dense(
                pycolmap,
                images,
                sparse,
                scene_dir / "dense",
                reconstruction,
                mvs_max_image_size,
                poisson_depth,
                mvs_iterations,
            )
        )
    _write_phases(scene_dir, phases)


def _run_dense(
    pycolmap,
    images: Path,
    sparse: Path,
    dense_dir: Path,
    reconstruction,
    mvs_max_image_size: int,
    poisson_depth: int,
    mvs_iterations: int | None = None,
) -> dict[str, float]:
    image_count = sum(1 for path in images.iterdir() if path.is_file()) if images.exists() else 0
    if image_count and reconstruction.num_reg_images() / image_count < 0.7:
        raise RuntimeError("COLMAP registration rate is below 70%; dense reconstruction skipped")
    phase_start = perf_counter()
    pycolmap.undistort_images(dense_dir, sparse, images)
    undistort_seconds = perf_counter() - phase_start
    patch_match_options = pycolmap.PatchMatchOptions()
    if mvs_max_image_size > 0:
        patch_match_options.max_image_size = mvs_max_image_size
    if mvs_iterations is not None:
        patch_match_options.num_iterations = mvs_iterations
    phase_start = perf_counter()
    pycolmap.patch_match_stereo(dense_dir, options=patch_match_options)
    patchmatch_seconds = perf_counter() - phase_start
    fused = dense_dir / "fused.ply"
    fusion_options = pycolmap.StereoFusionOptions()
    if mvs_max_image_size > 0:
        fusion_options.max_image_size = mvs_max_image_size
    phase_start = perf_counter()
    pycolmap.stereo_fusion(fused, dense_dir, options=fusion_options, output_type="ply")
    fusion_seconds = perf_counter() - phase_start
    if not _ply_vertices(fused):
        raise RuntimeError("COLMAP stereo fusion produced an empty point cloud")
    phase_start = perf_counter()
    try:
        mesh = dense_dir / "meshed-poisson.ply"
        mesh_options = pycolmap.PoissonMeshingOptions()
        mesh_options.depth = poisson_depth
        mesh_options.num_threads = 12
        pycolmap.poisson_meshing(fused, mesh, mesh_options)
        if mesh.exists() and not _ply_vertices(mesh):
            mesh.unlink()
            (dense_dir / "mesh-error.txt").write_text("Poisson mesh contains no vertices", encoding="utf-8")
    except Exception as error:  # Mesh is optional; preserve a valid dense cloud.
        (dense_dir / "mesh-error.txt").write_text(str(error), encoding="utf-8")
    return {
        "undistort_seconds": undistort_seconds,
        "patchmatch_seconds": patchmatch_seconds,
        "fusion_seconds": fusion_seconds,
        "meshing_seconds": perf_counter() - phase_start,
    }


def run_dense_only(
    scene_dir: Path, mvs_max_image_size: int = 0, poisson_depth: int = 10, mvs_iterations: int | None = None
) -> None:
    """Build dense artifacts from an existing sparse model without modifying it."""
    import pycolmap

    sparse = scene_dir / "sparse"
    if (sparse / "0").is_dir():
        sparse = sparse / "0"
    reconstruction = pycolmap.Reconstruction(sparse)
    phases = _run_dense(
        pycolmap,
        scene_dir / "images",
        sparse,
        scene_dir / "dense",
        reconstruction,
        mvs_max_image_size,
        poisson_depth,
        mvs_iterations,
    )
    _write_phases(scene_dir, phases)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene-dir", type=Path, required=True)
    parser.add_argument("--matcher", choices=("exhaustive", "sequential"))
    parser.add_argument(
        "--camera-model",
        choices=("SIMPLE_RADIAL", "OPENCV", "PINHOLE", "SIMPLE_PINHOLE"),
        default="SIMPLE_RADIAL",
    )
    parser.add_argument("--mvs-max-image-size", type=int, default=0)
    parser.add_argument("--poisson-depth", type=int, default=10)
    parser.add_argument("--mapper", choices=("incremental", "global"), default="incremental")
    parser.add_argument("--matching-db", type=Path)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--shared-camera", action="store_true")
    parser.add_argument("--mvs-iterations", type=int, choices=range(1, 6))
    dense_group = parser.add_mutually_exclusive_group()
    dense_group.add_argument("--dense", action="store_true")
    dense_group.add_argument("--dense-only", action="store_true")
    args = parser.parse_args()
    if args.dense_only:
        run_dense_only(args.scene_dir, args.mvs_max_image_size, args.poisson_depth, args.mvs_iterations)
    else:
        if args.matcher is None:
            parser.error("--matcher is required unless --dense-only is specified")
        run(
            args.scene_dir,
            args.matcher,
            args.dense,
            args.camera_model,
            args.mvs_max_image_size,
            args.poisson_depth,
            mapper=args.mapper,
            matching_db=args.matching_db,
            seed=args.seed,
            shared_camera=args.shared_camera,
            mvs_iterations=args.mvs_iterations,
        )


if __name__ == "__main__":
    main()
