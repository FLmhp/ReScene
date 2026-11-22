from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta

import jwt

from rescene_api.config import settings


def hash_password(password: str) -> str:
    if len(password) < 12:
        raise ValueError("Password must be at least 12 characters")
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, salt_text, digest_text = encoded.split("$", 2)
        if algorithm != "scrypt":
            return False
        salt = base64.b64decode(salt_text)
        expected = base64.b64decode(digest_text)
        actual = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def generate_email_code() -> str:
    """Six decimal digits; 900k values keep the online guess rate low enough for 5 attempts."""
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_email_code(user_id: str, purpose: str, code: str) -> str:
    """Digest a code with the server secret so the database never holds a usable code."""
    message = f"{user_id}:{purpose}:{code}".encode()
    return hmac.new(settings().jwt_secret.encode(), message, hashlib.sha256).hexdigest()


def issue_token(user_id: str, version: int = 0) -> str:
    """Issue a JWT tied to the user's current session version."""
    expires = datetime.now(UTC) + timedelta(minutes=settings().jwt_ttl_minutes)
    return jwt.encode({"sub": user_id, "exp": expires, "ver": version}, settings().jwt_secret, algorithm="HS256")


def decode_token(token: str) -> tuple[str, int]:
    """Read the subject and session version from a signed, expiring token."""
    payload = jwt.decode(token, settings().jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub"]})
    version = payload.get("ver", 0)
    if type(version) is not int:
        raise jwt.InvalidTokenError("Invalid session version")
    return payload["sub"], version
