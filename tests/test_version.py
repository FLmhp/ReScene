from pathlib import Path

import rescene
from rescene_api.main import app


def test_runtime_versions_match_the_single_version_file():
    expected = Path("VERSION").read_text(encoding="utf-8").strip()
    assert rescene.__version__ == expected
    assert app.version == expected
