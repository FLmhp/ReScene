"""Command-line interface for ReScene experiments."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from rescene.benchmark import _valid_id, disk_preflight, load_validation_frames, run_dataset_benchmark
from rescene.config import profile_config
from rescene.evaluation import evaluate_run
from rescene.job import run_job_spec
from rescene.pipeline import create_reuse_bundle, project_root, report_run, run_pipeline
from rescene.preprocess import preprocess_input


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rescene")
    commands = parser.add_subparsers(dest="command", required=True)
    preprocess = commands.add_parser("preprocess")
    preprocess.add_argument("--input", type=Path, required=True)
    preprocess.add_argument("--scene", required=True)
    preprocess.add_argument("--profile", default="balanced", choices=("fast", "balanced", "quality"))

    run = commands.add_parser("run")
    run.add_argument("--profile", required=True, choices=("fast", "balanced", "quality"))
    run.add_argument("--input", type=Path, required=True)
    run.add_argument("--run-id", required=True)
    run.add_argument("--resume", action="store_true")
    run.add_argument("--colmap-mvs-max-image-size", type=int, default=None)
    run.add_argument("--colmap-poisson-depth", type=int, default=None)
    run.add_argument("--diagnostics", action="store_true")
    run.add_argument("--validation-frames", type=Path, default=None)
    run.add_argument("--record-input-hashes", action="store_true")
    run.add_argument("--reuse-bundle", type=Path, default=None)
    run.add_argument("--reuse-sha256", default=None)
    run.add_argument("--reuse-stage", choices=("training", "dense"), default=None)

    reuse = commands.add_parser("create-reuse-bundle")
    reuse.add_argument("--source-run", type=Path, required=True)
    reuse.add_argument("--bundle-dir", type=Path, required=True)

    run_job = commands.add_parser("run-job")
    run_job.add_argument("--job-spec", type=Path, required=True)
    run_job.add_argument("--output", type=Path, required=True)
    run_job.add_argument("--resume", action="store_true")

    benchmark = commands.add_parser("benchmark")
    benchmark_source = benchmark.add_mutually_exclusive_group(required=True)
    benchmark_source.add_argument("--input", type=Path)
    benchmark_source.add_argument("--manifest", type=Path)
    benchmark.add_argument("--candidates", type=Path)
    benchmark.add_argument(
        "--profiles", nargs="+", default=["fast", "balanced", "quality"], help="space or comma separated"
    )
    benchmark.add_argument("--run-prefix", default="benchmark")
    benchmark.add_argument("--budget-hours", type=float, default=24.0)
    benchmark.add_argument("--runs-root", type=Path, default=None)
    benchmark.add_argument("--min-free-disk-bytes", type=int, default=None)
    benchmark.add_argument("--repeat", type=int, default=1)
    benchmark.add_argument("--split", choices=("calibration", "test", "validation"), default="calibration")
    benchmark.add_argument("--validation-frames", type=Path, default=None)
    benchmark.add_argument("--record-input-hashes", action="store_true")
    benchmark.add_argument("--diagnostics", action="store_true")
    benchmark.add_argument("--dry-run", action="store_true")
    benchmark.add_argument("--resume", action="store_true")

    report = commands.add_parser("report")
    report.add_argument("--run-id", required=True)

    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--run-id", required=True)
    evaluate.add_argument("--ground-truth-sparse", type=Path)
    evaluate.add_argument("--ground-truth-cloud", type=Path)
    evaluate.add_argument("--point-threshold", type=float, default=0.02)
    evaluate.add_argument("--official-evaluator", type=Path)
    return parser


def _validation_sources(path: Path, input_path: Path) -> set[str]:
    """Pick the frozen validation frames for one input directory."""
    scenes = load_validation_frames(path)
    raw = json.loads(path.read_text(encoding="utf-8"))["scenes"]
    resolved = str(Path(input_path).resolve())
    matched = [
        scene_id
        for scene_id, entry in raw.items()
        if isinstance(entry, dict) and entry.get("source") and str(Path(str(entry["source"])).resolve()) == resolved
    ]
    if len(matched) == 1:
        return scenes[matched[0]]
    if len(scenes) == 1:
        return next(iter(scenes.values()))
    raise ValueError(f"Cannot pick a scene from {path} for {input_path}; matched: {matched}")


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    if args.command == "preprocess":
        config = profile_config(args.profile)
        output = project_root() / "data" / args.scene
        manifest = preprocess_input(args.input, output, scene=args.scene, max_frames=config.max_frames)
        print(json.dumps(manifest["counts"], ensure_ascii=False))
        return
    if args.command == "run":
        overrides: dict[str, object] = {}
        if args.colmap_mvs_max_image_size is not None:
            overrides["colmap_mvs_max_image_size"] = args.colmap_mvs_max_image_size
        if args.colmap_poisson_depth is not None:
            overrides["colmap_poisson_depth"] = args.colmap_poisson_depth
        config = profile_config(args.profile).with_overrides(overrides) if overrides else None
        validation_sources = None
        if args.validation_frames is not None:
            validation_sources = _validation_sources(args.validation_frames, args.input)
        print(
            run_pipeline(
                args.profile,
                args.input,
                args.run_id,
                resume=args.resume,
                config_override=config,
                record_hashes=args.record_input_hashes,
                diagnostics=args.diagnostics,
                validation_sources=validation_sources,
                reuse_bundle=args.reuse_bundle,
                reuse_sha256=args.reuse_sha256,
                reuse_stage=args.reuse_stage,
            )
        )
        return
    if args.command == "create-reuse-bundle":
        print(create_reuse_bundle(args.source_run, args.bundle_dir))
        return
    if args.command == "run-job":
        print(run_job_spec(args.job_spec, args.output, force_resume=args.resume))
        return
    if args.command == "benchmark":
        args.profiles = [item for value in args.profiles for item in value.split(",") if item]
        unknown = set(args.profiles) - {"fast", "balanced", "quality"}
        if not args.profiles or unknown:
            raise ValueError(f"Unknown profiles: {', '.join(sorted(unknown)) or 'none given'}")
        if args.manifest:
            if not args.candidates:
                raise ValueError("--candidates is required with --manifest")
            print(
                run_dataset_benchmark(
                    args.manifest,
                    args.candidates,
                    args.profiles,
                    args.run_prefix,
                    args.budget_hours,
                    dry_run=args.dry_run,
                    resume=args.resume,
                    split=args.split,
                    repeat=args.repeat,
                    validation_frames=args.validation_frames,
                    record_hashes=args.record_input_hashes,
                    diagnostics=args.diagnostics,
                    runs_root=args.runs_root,
                    min_free_disk_bytes=args.min_free_disk_bytes,
                )
            )
            return
        if args.candidates or args.dry_run:
            raise ValueError("--candidates and --dry-run require --manifest")
        _valid_id(args.run_prefix, "run prefix")
        root = project_root()
        trial_root = args.runs_root.resolve() if args.runs_root is not None else root / "runs"
        output = root / "calibration" / args.run_prefix
        output.mkdir(parents=True, exist_ok=True)
        preflights = []
        configs = [profile_config(name) for name in args.profiles]
        shared_limit = min(config.max_frames for config in configs)
        for config in configs:
            run_id = f"{args.run_prefix}-{config.name.value}"
            preflight = disk_preflight(trial_root, run_id, args.min_free_disk_bytes)
            preflights.append(preflight)
            (output / "disk-preflights.json").write_text(
                json.dumps(preflights, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            if preflight["status"] != "ok":
                (output / "failures.json").write_text(
                    json.dumps([{**preflight, "reason": "disk_preflight"}], ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                raise RuntimeError(f"Disk preflight failed for {run_id}: {preflight['status']}")
            print(
                run_pipeline(
                    config.name.value,
                    args.input,
                    run_id,
                    frame_limit=shared_limit,
                    resume=args.resume,
                    output_dir=trial_root / run_id,
                )
            )
        return
    if args.command == "evaluate":
        metrics = evaluate_run(
            project_root() / "runs" / args.run_id,
            args.ground_truth_sparse,
            args.ground_truth_cloud,
            args.point_threshold,
            args.official_evaluator,
        )
        print(json.dumps(metrics, ensure_ascii=False))
        return
    print(report_run(args.run_id))


if __name__ == "__main__":
    main()
