"""Access-log redaction for share links.

Share tokens are bearer credentials: whoever reads one from a log can open the
scene. Uvicorn writes the full request target of every response, so the access
log handler is filtered to replace the token segment with a fixed placeholder
while keeping the method, route class and status code.
"""

from __future__ import annotations

import copy
import logging
from typing import Any

import uvicorn.config

SHARE_PATH = "/v1/public/shares/"
REDACTED = "<redacted>"
ACCESS_LOGGER = "uvicorn.access"
FILTER_NAME = "share_access_filter"


def redact_target(target: str) -> str:
    """Return ``target`` with the share credential replaced and its query string dropped."""
    prefix_at = target.find(SHARE_PATH)
    if prefix_at == -1:
        return target
    path = target.split("?", 1)[0]
    credential_at = prefix_at + len(SHARE_PATH)
    suffix_at = path.find("/", credential_at)
    if suffix_at == -1:
        suffix_at = len(path)
    return f"{path[:credential_at]}{REDACTED}{path[suffix_at:]}"


class ShareAccessFilter(logging.Filter):
    """Rewrite the request target of ``uvicorn.access`` records in place."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != ACCESS_LOGGER or not isinstance(record.args, tuple) or len(record.args) < 3:
            return True
        target = record.args[2]
        if isinstance(target, str):
            redacted = redact_target(target)
            if redacted != target:
                record.args = (*record.args[:2], redacted, *record.args[3:])
        return True


def logging_config() -> dict[str, Any]:
    """Uvicorn's default logging configuration plus the access-log filter."""
    config: dict[str, Any] = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    config["filters"] = {FILTER_NAME: {"()": "rescene_api.access_logging.ShareAccessFilter"}}
    config["handlers"]["access"]["filters"] = [FILTER_NAME]
    return config


LOGGING_CONFIG = logging_config()
