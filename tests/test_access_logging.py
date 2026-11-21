import json
import logging
import logging.config
from pathlib import Path

import pytest

from rescene_api.access_logging import (
    FILTER_NAME,
    LOGGING_CONFIG,
    REDACTED,
    ShareAccessFilter,
    redact_target,
)

ACCESS_MESSAGE = '%s - "%s %s HTTP/%s" %d'


def access_record(target: str, *, status_code: int = 200, method: str = "GET", name: str = "uvicorn.access"):
    return logging.LogRecord(
        name=name,
        level=logging.INFO,
        pathname=__file__,
        lineno=0,
        msg=ACCESS_MESSAGE,
        args=("172.17.0.1:54321", method, target, "1.1", status_code),
        exc_info=None,
    )


def rendered(record: logging.LogRecord) -> str:
    return logging.Formatter("%(message)s").format(record)


@pytest.fixture
def uvicorn_access_logger():
    previous = logging.getLogger("uvicorn.access")
    saved = previous.handlers[:], previous.propagate, previous.level
    try:
        yield previous
    finally:
        previous.handlers[:] = saved[0]
        previous.propagate = saved[1]
        previous.setLevel(saved[2])


def test_share_target_loses_the_credential_and_its_query() -> None:
    record = access_record("/v1/public/shares/synthetic-share-token?token=synthetic-share-token")
    assert ShareAccessFilter().filter(record) is True
    assert rendered(record) == '172.17.0.1:54321 - "GET /v1/public/shares/<redacted> HTTP/1.1" 200'


def test_qr_target_keeps_the_suffix() -> None:
    record = access_record("/v1/public/shares/synthetic-share-token/qr.png?ts=1", status_code=404)
    ShareAccessFilter().filter(record)
    assert rendered(record) == '172.17.0.1:54321 - "GET /v1/public/shares/<redacted>/qr.png HTTP/1.1" 404'


def test_prefixed_target_is_redacted_too() -> None:
    assert redact_target("/api/v1/public/shares/synthetic-share-token") == "/api/v1/public/shares/<redacted>"


def test_ordinary_routes_keep_their_query_string() -> None:
    target = "/v1/projects?page=2&q=scene"
    record = access_record(target)
    ShareAccessFilter().filter(record)
    assert rendered(record) == '172.17.0.1:54321 - "GET /v1/projects?page=2&q=scene HTTP/1.1" 200'


def test_other_loggers_and_shapes_pass_through() -> None:
    application = access_record("/v1/public/shares/synthetic-share-token", name="rescene_api.main")
    ShareAccessFilter().filter(application)
    assert application.args[2] == "/v1/public/shares/synthetic-share-token"
    unexpected = logging.LogRecord(
        name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=0, msg="no args", args=(), exc_info=None
    )
    assert ShareAccessFilter().filter(unexpected) is True


def test_logging_config_filters_the_access_handler_only(uvicorn_access_logger, capsys) -> None:
    logging.config.dictConfig(LOGGING_CONFIG)
    access_handler = uvicorn_access_logger.handlers[0]
    assert [type(filter_).__name__ for filter_ in access_handler.filters] == ["ShareAccessFilter"]
    assert logging.getLogger("uvicorn").handlers[0].filters == []

    uvicorn_access_logger.info(*_args("/v1/public/shares/synthetic-share-token"), stacklevel=1)
    access_handler.flush()
    output = capsys.readouterr().out
    assert "synthetic-share-token" not in output
    assert "/v1/public/shares/<redacted>" in output


def _args(target: str) -> tuple[object, ...]:
    return ('%s - "%s %s HTTP/%s" %d', "172.17.0.1:54321", "GET", target, "1.1", 200)


def test_image_log_config_matches_the_module_config() -> None:
    shipped = json.loads((Path(__file__).parents[1] / "infra/api/uvicorn-log-config.json").read_text("utf-8"))
    assert shipped["filters"] == {FILTER_NAME: {"()": "rescene_api.access_logging.ShareAccessFilter"}}
    assert shipped["filters"] == LOGGING_CONFIG["filters"]
    assert shipped["formatters"] == LOGGING_CONFIG["formatters"]
    assert shipped["loggers"] == LOGGING_CONFIG["loggers"]
    assert shipped["handlers"]["default"] == LOGGING_CONFIG["handlers"]["default"]
    assert shipped["handlers"]["access"]["filters"] == [FILTER_NAME]
    assert shipped["handlers"]["access"]["filters"] == LOGGING_CONFIG["handlers"]["access"]["filters"]
    assert {key: value for key, value in shipped["handlers"]["access"].items() if key != "filters"} == {
        key: value for key, value in LOGGING_CONFIG["handlers"]["access"].items() if key != "filters"
    }
    assert REDACTED == "<redacted>"
