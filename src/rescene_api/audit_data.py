"""Keep credentials and active spreadsheet cells out of exported audit data."""

from __future__ import annotations

import re

_PRIVATE_KEYS = {
    "body",
    "codehash",
    "emailmessage",
    "emailcontent",
    "html",
    "mail",
    "mailmessage",
    "otp",
    "mailcontent",
    "payload",
    "signedlink",
}
_PRIVATE_KEY_MARKERS = (
    "apikey",
    "authcode",
    "authorization",
    "avatar",
    "base64",
    "cookie",
    "credential",
    "emailbody",
    "invitationcode",
    "invitecode",
    "mailbody",
    "mailpayload",
    "onetimecode",
    "passphrase",
    "passwd",
    "password",
    "presigned",
    "privatekey",
    "resetcode",
    "secret",
    "signature",
    "signedurl",
    "token",
    "verificationcode",
)
_PRIVATE_VALUE = re.compile(
    r"(?:^\s*(?:data:|bearer\s|basic\s|eyJ[\w-]+\.[\w-]+\.[\w-]+\s*$)"
    r"|[?&](?:x-amz-[\w-]+|x-oss-[\w-]+|signature|sig|ossaccesskeyid|access_token|token)=)",
    re.IGNORECASE,
)


def _clean(value: object) -> object:
    if isinstance(value, dict):
        return redact_audit_metadata(value)
    if isinstance(value, (tuple, list)):
        return [_clean(child) for child in value]
    if isinstance(value, str) and _PRIVATE_VALUE.search(value):
        return "[已隐藏]"
    return value


def redact_audit_metadata(metadata: dict[str, object]) -> dict[str, object]:
    """Apply the same recursive redaction before storing and when reading legacy rows."""
    clean: dict[str, object] = {}
    for key, value in metadata.items():
        name = re.sub(r"[^a-z0-9]", "", key.lower())
        if name in _PRIVATE_KEYS or any(marker in name for marker in _PRIVATE_KEY_MARKERS):
            continue
        if name == "code" and str(value).strip().isdigit():
            continue  # Retain named worker error codes, but not anonymous numeric codes.
        clean[key] = _clean(value)
    return clean


def safe_csv_cell(cell: str) -> str:
    """Force formula-like values to be treated as text by spreadsheets."""
    first = cell.lstrip()[:1]
    return "'" + cell if first in {"=", "+", "-", "@"} or cell.startswith(("\t", "\n", "\r")) else cell
