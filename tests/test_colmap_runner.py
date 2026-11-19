import sys
from types import SimpleNamespace

import pytest

from rescene.colmap_runner import run


def test_poisson_meshing_receives_cloud_before_mesh(tmp_path, monkeypatch):
    calls = []
    fusion_calls = []

    class Reconstruction:
        def num_reg_images(self):
            return 1

        def write(self, path):
            pass

    def poisson_meshing(fused, mesh, options):
        calls.append((fused, mesh, options.depth, options.num_threads))
        mesh.parent.mkdir(parents=True, exist_ok=True)
        mesh.write_text("ply\nelement vertex 0\nend_header\n", encoding="ascii")

    def stereo_fusion(fused, dense_dir, **kwargs):
        fusion_calls.append(((fused, dense_dir), kwargs["options"].max_image_size, kwargs["output_type"]))
        fused.parent.mkdir(parents=True, exist_ok=True)
        fused.write_text("ply\nelement vertex 2\nend_header\n", encoding="ascii")

    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        ImageReaderOptions=lambda: SimpleNamespace(camera_model=None),
        extract_features=lambda *args, **kwargs: None,
        match_exhaustive=lambda *args, **kwargs: None,
        match_sequential=lambda *args, **kwargs: None,
        incremental_mapping=lambda *args, **kwargs: {0: Reconstruction()},
        bundle_adjustment=lambda *args, **kwargs: None,
        undistort_images=lambda *args, **kwargs: None,
        patch_match_stereo=lambda *args, **kwargs: None,
        PatchMatchOptions=lambda: SimpleNamespace(max_image_size=-1),
        StereoFusionOptions=lambda: SimpleNamespace(max_image_size=-1),
        stereo_fusion=stereo_fusion,
        PoissonMeshingOptions=lambda: SimpleNamespace(depth=None, num_threads=None),
        poisson_meshing=poisson_meshing,
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run(tmp_path, "exhaustive", dense=True)

    assert fusion_calls == [((tmp_path / "dense" / "fused.ply", tmp_path / "dense"), -1, "ply")]
    assert calls == [(tmp_path / "dense" / "fused.ply", tmp_path / "dense" / "meshed-poisson.ply", 10, 12)]
    assert not (tmp_path / "dense" / "meshed-poisson.ply").exists()
    assert (tmp_path / "dense" / "mesh-error.txt").exists()


def test_sequential_mapping_has_one_exhaustive_fallback(tmp_path, monkeypatch):
    mapping_calls = []
    exhaustive_calls = []

    class Reconstruction:
        def num_reg_images(self):
            return 2

        def write(self, path):
            pass

    def incremental_mapping(*args, **kwargs):
        mapping_calls.append((args, kwargs))
        return {} if len(mapping_calls) == 1 else {0: Reconstruction()}

    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        ImageReaderOptions=lambda: SimpleNamespace(camera_model=None),
        extract_features=lambda *args, **kwargs: None,
        match_exhaustive=lambda *args, **kwargs: exhaustive_calls.append((args, kwargs)),
        match_sequential=lambda *args, **kwargs: None,
        incremental_mapping=incremental_mapping,
        bundle_adjustment=lambda *args, **kwargs: None,
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run(tmp_path, "sequential", dense=False)

    assert len(mapping_calls) == 2
    assert len(exhaustive_calls) == 1


def test_seed_reaches_match_verification_and_incremental_mapper(tmp_path, monkeypatch):
    calls = {}
    reconstruction = SimpleNamespace(write=lambda path: None)

    def match(_database, **kwargs):
        calls["ransac"] = kwargs["verification_options"].ransac.random_seed
        calls["matching_threads"] = kwargs["matching_options"].num_threads

    def map_images(*args, **kwargs):
        calls["mapper"] = kwargs["options"].random_seed
        calls["mapping_threads"] = kwargs["options"].num_threads
        return {0: reconstruction}

    reconstruction.num_reg_images = lambda: 2
    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        ImageReaderOptions=SimpleNamespace,
        TwoViewGeometryOptions=lambda: SimpleNamespace(ransac=SimpleNamespace(random_seed=-1)),
        IncrementalPipelineOptions=SimpleNamespace,
        FeatureExtractionOptions=SimpleNamespace,
        FeatureMatchingOptions=SimpleNamespace,
        BundleAdjustmentOptions=lambda: SimpleNamespace(ceres=SimpleNamespace(solver_options=SimpleNamespace())),
        set_random_seed=lambda value: calls.update(global_seed=value),
        extract_features=lambda *args, **kwargs: calls.update(
            extraction_threads=kwargs["extraction_options"].num_threads
        ),
        match_exhaustive=match,
        incremental_mapping=map_images,
        bundle_adjustment=lambda *args, **kwargs: calls.update(
            adjustment_threads=kwargs["options"].ceres.solver_options.num_threads
        ),
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run(tmp_path, "exhaustive", dense=False, seed=42, sparse_threads=1)

    assert calls == {
        "global_seed": 42,
        "ransac": 42,
        "mapper": 42,
        "extraction_threads": 1,
        "matching_threads": 1,
        "mapping_threads": 1,
        "adjustment_threads": 1,
    }


def test_failed_default_mapping_retries_with_relaxed_single_camera(tmp_path, monkeypatch):
    extraction_calls = []
    mapping_calls = []

    class Reconstruction:
        def num_reg_images(self):
            return 2

        def write(self, path):
            pass

    class PipelineOptions:
        def __init__(self):
            self.min_num_matches = 15
            self.mapper = SimpleNamespace(
                init_min_num_inliers=100,
                init_min_tri_angle=16.0,
                init_max_error=4.0,
                init_max_forward_motion=0.95,
                abs_pose_min_num_inliers=30,
                abs_pose_min_inlier_ratio=0.25,
            )

    def incremental_mapping(*args, **kwargs):
        mapping_calls.append((args, kwargs))
        return {} if len(mapping_calls) == 1 else {0: Reconstruction()}

    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        CameraMode=SimpleNamespace(SINGLE="single"),
        ImageReaderOptions=lambda: SimpleNamespace(camera_model=None),
        IncrementalPipelineOptions=PipelineOptions,
        extract_features=lambda *args, **kwargs: extraction_calls.append((args, kwargs)),
        match_exhaustive=lambda *args, **kwargs: None,
        match_sequential=lambda *args, **kwargs: None,
        incremental_mapping=incremental_mapping,
        bundle_adjustment=lambda *args, **kwargs: None,
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run(tmp_path, "exhaustive", dense=False)

    assert len(mapping_calls) == 2
    assert extraction_calls[-1][1]["camera_mode"] == "single"
    options = mapping_calls[-1][1]["options"]
    assert options.mapper.init_min_num_inliers == 30
    assert options.mapper.init_min_tri_angle == 4.0


def test_dense_knobs_reach_pycolmap(tmp_path, monkeypatch):
    patch_match_calls = []
    fusion_calls = []
    mesh_calls = []

    class Reconstruction:
        def num_reg_images(self):
            return 1

        def write(self, path):
            pass

    def patch_match_stereo(dense_dir, **kwargs):
        patch_match_calls.append(kwargs["options"].max_image_size)

    def stereo_fusion(fused, dense_dir, **kwargs):
        fusion_calls.append(kwargs["options"].max_image_size)
        fused.parent.mkdir(parents=True, exist_ok=True)
        fused.write_text("ply\nelement vertex 3\nend_header\n", encoding="ascii")

    def poisson_meshing(fused, mesh, options):
        mesh_calls.append(options.depth)
        mesh.parent.mkdir(parents=True, exist_ok=True)
        mesh.write_text("ply\nelement vertex 3\nend_header\n", encoding="ascii")

    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        ImageReaderOptions=lambda: SimpleNamespace(camera_model=None),
        extract_features=lambda *args, **kwargs: None,
        match_exhaustive=lambda *args, **kwargs: None,
        match_sequential=lambda *args, **kwargs: None,
        incremental_mapping=lambda *args, **kwargs: {0: Reconstruction()},
        bundle_adjustment=lambda *args, **kwargs: None,
        undistort_images=lambda *args, **kwargs: None,
        PatchMatchOptions=lambda: SimpleNamespace(max_image_size=-1),
        StereoFusionOptions=lambda: SimpleNamespace(max_image_size=-1),
        patch_match_stereo=patch_match_stereo,
        stereo_fusion=stereo_fusion,
        PoissonMeshingOptions=lambda: SimpleNamespace(depth=None, num_threads=None),
        poisson_meshing=poisson_meshing,
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run(tmp_path, "exhaustive", dense=True, mvs_max_image_size=1200, poisson_depth=12)

    assert patch_match_calls == [1200]
    assert fusion_calls == [1200]
    assert mesh_calls == [12]


def test_full_resolution_leaves_pycolmap_defaults(tmp_path, monkeypatch):
    patch_match_calls = []
    fusion_calls = []

    class Reconstruction:
        def num_reg_images(self):
            return 1

        def write(self, path):
            pass

    def stereo_fusion(fused, dense_dir, **kwargs):
        fusion_calls.append(kwargs["options"].max_image_size)
        fused.parent.mkdir(parents=True, exist_ok=True)
        fused.write_text("ply\nelement vertex 3\nend_header\n", encoding="ascii")

    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        ImageReaderOptions=lambda: SimpleNamespace(camera_model=None),
        extract_features=lambda *args, **kwargs: None,
        match_exhaustive=lambda *args, **kwargs: None,
        match_sequential=lambda *args, **kwargs: None,
        incremental_mapping=lambda *args, **kwargs: {0: Reconstruction()},
        bundle_adjustment=lambda *args, **kwargs: None,
        undistort_images=lambda *args, **kwargs: None,
        PatchMatchOptions=lambda: SimpleNamespace(max_image_size=-1),
        StereoFusionOptions=lambda: SimpleNamespace(max_image_size=-1),
        patch_match_stereo=lambda *args, **kwargs: patch_match_calls.append(kwargs["options"].max_image_size),
        stereo_fusion=stereo_fusion,
        PoissonMeshingOptions=lambda: SimpleNamespace(depth=None, num_threads=None),
        poisson_meshing=lambda *args, **kwargs: None,
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run(tmp_path, "exhaustive", dense=True, mvs_max_image_size=0)

    assert patch_match_calls == [-1]
    assert fusion_calls == [-1]


def test_empty_dense_cloud_is_a_failure(tmp_path, monkeypatch):
    class Reconstruction:
        def num_reg_images(self):
            return 2

        def write(self, path):
            pass

    def stereo_fusion(fused, *args, **kwargs):
        fused.parent.mkdir(parents=True, exist_ok=True)
        fused.write_text("ply\nelement vertex 0\nend_header\n", encoding="ascii")

    fake = SimpleNamespace(
        Device=SimpleNamespace(cuda="cuda"),
        ImageReaderOptions=lambda: SimpleNamespace(camera_model=None),
        extract_features=lambda *args, **kwargs: None,
        match_exhaustive=lambda *args, **kwargs: None,
        match_sequential=lambda *args, **kwargs: None,
        incremental_mapping=lambda *args, **kwargs: {0: Reconstruction()},
        bundle_adjustment=lambda *args, **kwargs: None,
        undistort_images=lambda *args, **kwargs: None,
        patch_match_stereo=lambda *args, **kwargs: None,
        PatchMatchOptions=lambda: SimpleNamespace(max_image_size=-1),
        StereoFusionOptions=lambda: SimpleNamespace(max_image_size=-1),
        stereo_fusion=stereo_fusion,
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    with pytest.raises(RuntimeError, match="empty point cloud"):
        run(tmp_path, "exhaustive", dense=True)


@pytest.mark.parametrize("nested", [True, False])
def test_dense_only_reuses_existing_inputs(tmp_path, monkeypatch, nested):
    from rescene.colmap_runner import run_dense_only

    images = tmp_path / "images"
    sparse = tmp_path / "sparse" / "0" if nested else tmp_path / "sparse"
    images.mkdir()
    sparse.mkdir(parents=True)
    image = images / "image.jpg"
    model = sparse / "images.bin"
    image.write_bytes(b"original image")
    model.write_bytes(b"original model")
    calls = []

    class Reconstruction:
        def __init__(self, path):
            calls.append(("load", path))

        def num_reg_images(self):
            return 1

    def stereo_fusion(fused, dense_dir, **kwargs):
        calls.append(("fusion", dense_dir, kwargs["options"].max_image_size))
        fused.parent.mkdir(parents=True, exist_ok=True)
        fused.write_text("ply\nelement vertex 2\nend_header\n", encoding="ascii")

    fake = SimpleNamespace(
        Reconstruction=Reconstruction,
        undistort_images=lambda dense, model, source: calls.append(("undistort", dense, model, source)),
        PatchMatchOptions=lambda: SimpleNamespace(max_image_size=-1),
        patch_match_stereo=lambda dense, **kwargs: calls.append(("patch", dense, kwargs["options"].max_image_size)),
        StereoFusionOptions=lambda: SimpleNamespace(max_image_size=-1),
        stereo_fusion=stereo_fusion,
        PoissonMeshingOptions=lambda: SimpleNamespace(depth=None, num_threads=None),
        poisson_meshing=lambda fused, mesh, options: calls.append(("mesh", fused, mesh, options.depth)),
    )
    monkeypatch.setitem(sys.modules, "pycolmap", fake)

    run_dense_only(tmp_path, mvs_max_image_size=1200, poisson_depth=12)

    dense = tmp_path / "dense"
    assert calls == [
        ("load", sparse),
        ("undistort", dense, sparse, images),
        ("patch", dense, 1200),
        ("fusion", dense, 1200),
        ("mesh", dense / "fused.ply", dense / "meshed-poisson.ply", 12),
    ]
    assert image.read_bytes() == b"original image"
    assert model.read_bytes() == b"original model"
    assert not (tmp_path / "database.db").exists()
    assert not (tmp_path / "sparse-work").exists()


def test_dense_only_cli_does_not_require_matcher(tmp_path, monkeypatch):
    from rescene import colmap_runner

    calls = []
    monkeypatch.setattr(colmap_runner, "run_dense_only", lambda *args: calls.append(args))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "colmap_runner",
            "--scene-dir",
            str(tmp_path),
            "--dense-only",
            "--mvs-max-image-size",
            "1200",
            "--poisson-depth",
            "12",
        ],
    )

    colmap_runner.main()

    assert calls == [(tmp_path, 1200, 12, None)]


def test_cli_still_requires_matcher_for_full_run(tmp_path, monkeypatch):
    from rescene import colmap_runner

    monkeypatch.setattr(sys, "argv", ["colmap_runner", "--scene-dir", str(tmp_path)])
    with pytest.raises(SystemExit):
        colmap_runner.main()
