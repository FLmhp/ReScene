from pathlib import Path

import pytest

from rescene.stages import StageStore


def test_stage_success_and_output_validation(tmp_path: Path) -> None:
    store = StageStore(tmp_path / "stages")
    output = tmp_path / "artifact.bin"
    with store.running("work", stage="work"):
        output.write_bytes(b"ok")

    assert store.complete("work", [output])
    output.unlink()
    assert not store.complete("work", [output])


def test_stage_failure_records_reason(tmp_path: Path) -> None:
    store = StageStore(tmp_path / "stages")
    with pytest.raises(RuntimeError), store.running("work"):
        raise RuntimeError("boom")
    assert store.read("work")["status"] == "failed"
    assert "boom" in str(store.read("work")["error"])
