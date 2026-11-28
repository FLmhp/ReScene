from __future__ import annotations

import re
import unicodedata

USERNAME_MIN_LEN = 3
USERNAME_MAX_LEN = 32

# Allowed: ASCII letters/digits, underscore, hyphen, CJK Unified Ideographs.
_ALLOWED_CHARS = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]+$")
# Must contain at least one letter (ASCII or CJK) or digit.
_HAS_ALPHA_OR_DIGIT = re.compile(r"[A-Za-z0-9\u4e00-\u9fff]")


class UsernameValidationError(ValueError):
    """A username failed format or length checks."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


def normalize_username(value: str) -> tuple[str, str]:
    """Return (display_username, username_key) for a raw input.

    display_username preserves the original casing after NFKC normalization and
    trimming. username_key is the ASCII-only lowercase fold used for lookups and
    uniqueness checks.
    """
    normalized = unicodedata.normalize("NFKC", value).strip()
    if "@" in normalized:
        raise UsernameValidationError("Username cannot contain '@'", "username.invalid_char")
    length = len(normalized)
    if length < USERNAME_MIN_LEN or length > USERNAME_MAX_LEN:
        raise UsernameValidationError(
            f"Username must be {USERNAME_MIN_LEN}-{USERNAME_MAX_LEN} characters",
            "username.invalid_length",
        )
    if not _ALLOWED_CHARS.match(normalized):
        raise UsernameValidationError("Username contains invalid characters", "username.invalid_char")
    if not _HAS_ALPHA_OR_DIGIT.search(normalized):
        raise UsernameValidationError("Username must contain a letter or digit", "username.invalid_char")
    key = "".join(ch.lower() if "A" <= ch <= "Z" else ch for ch in normalized)
    return normalized, key


def legacy_email_key(value: str) -> str:
    """The same normalization used for legacy email identifiers in the database."""
    return value.strip().lower()


def escape_like(value: str) -> str:
    """Escape SQL LIKE wildcards so a user-supplied fragment cannot match broadly."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
