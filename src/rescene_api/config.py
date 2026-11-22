from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_url: str
    jwt_secret: str
    jwt_ttl_minutes: int
    worker_token: str
    cors_origins: tuple[str, ...]
    admin_email: str | None
    admin_password_file: Path | None
    oss_endpoint: str | None
    oss_region: str
    oss_bucket: str | None
    oss_access_key_id: str | None
    oss_access_key_secret: str | None
    oss_role_arn: str | None
    stale_upload_seconds: int = 86400
    public_web_url: str = "https://app.rescene.xyz"
    auth_rate_limit: int = 10
    job_log_limit: int = 2000
    environment: str = "development"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    smtp_security: str = "starttls"
    smtp_timeout_seconds: float = 10.0
    email_code_ttl_minutes: int = 10
    email_code_cooldown_seconds: int = 60
    email_code_hourly_limit: int = 5
    email_code_max_attempts: int = 5


def _secret(name: str, file_name: str, default: str | None = None) -> str | None:
    path = os.environ.get(file_name)
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    return os.environ.get(name, default)


@lru_cache
def settings() -> Settings:
    password_file = os.environ.get("RESCENE_ADMIN_PASSWORD_FILE")
    database_url = os.environ.get("RESCENE_DATABASE_URL")
    if not database_url:
        db_password = _secret("RESCENE_DB_PASSWORD", "RESCENE_DB_PASSWORD_FILE")
        database_url = (
            f"postgresql+psycopg://rescene:{db_password}@rescene-db:5432/rescene"
            if db_password
            else "sqlite:///./rescene.db"
        )
    return Settings(
        database_url=database_url,
        jwt_secret=_secret("RESCENE_JWT_SECRET", "RESCENE_JWT_SECRET_FILE", "development-only-change-me") or "",
        jwt_ttl_minutes=int(os.environ.get("RESCENE_JWT_TTL_MINUTES", "60")),
        worker_token=_secret("RESCENE_WORKER_TOKEN", "RESCENE_WORKER_TOKEN_FILE", "development-worker-token") or "",
        cors_origins=tuple(
            item.strip()
            for item in os.environ.get(
                "RESCENE_CORS_ORIGINS",
                ",".join(
                    (
                        "http://localhost:3000",
                        "http://127.0.0.1:3000",
                        "http://localhost:8081",
                        "http://localhost:1420",
                        "http://tauri.localhost",
                        "tauri://localhost",
                    )
                ),
            ).split(",")
            if item.strip()
        ),
        admin_email=os.environ.get("RESCENE_ADMIN_EMAIL"),
        admin_password_file=Path(password_file) if password_file else None,
        oss_endpoint=os.environ.get("RESCENE_OSS_ENDPOINT"),
        oss_region=os.environ.get("RESCENE_OSS_REGION", "oss-cn-beijing"),
        oss_bucket=os.environ.get("RESCENE_OSS_BUCKET"),
        oss_access_key_id=os.environ.get("RESCENE_OSS_ACCESS_KEY_ID"),
        oss_access_key_secret=_secret("RESCENE_OSS_ACCESS_KEY_SECRET", "RESCENE_OSS_ACCESS_KEY_SECRET_FILE"),
        oss_role_arn=os.environ.get("RESCENE_OSS_ROLE_ARN"),
        stale_upload_seconds=int(os.environ.get("RESCENE_STALE_UPLOAD_SECONDS", "86400")),
        public_web_url=os.environ.get("RESCENE_PUBLIC_WEB_URL", "https://app.rescene.xyz"),
        auth_rate_limit=int(os.environ.get("RESCENE_AUTH_RATE_LIMIT", "10")),
        job_log_limit=int(os.environ.get("RESCENE_JOB_LOG_LIMIT", "2000")),
        environment=os.environ.get("RESCENE_ENV", "development").strip().lower() or "development",
        smtp_host=(os.environ.get("RESCENE_SMTP_HOST") or "").strip() or None,
        smtp_port=int(os.environ.get("RESCENE_SMTP_PORT", "587")),
        smtp_username=(os.environ.get("RESCENE_SMTP_USERNAME") or "").strip() or None,
        smtp_password=_secret("RESCENE_SMTP_PASSWORD", "RESCENE_SMTP_PASSWORD_FILE"),
        smtp_from=(os.environ.get("RESCENE_SMTP_FROM") or "").strip() or None,
        smtp_security=os.environ.get("RESCENE_SMTP_SECURITY", "starttls").strip().lower() or "starttls",
        smtp_timeout_seconds=float(os.environ.get("RESCENE_SMTP_TIMEOUT_SECONDS", "10")),
        email_code_ttl_minutes=int(os.environ.get("RESCENE_EMAIL_CODE_TTL_MINUTES", "10")),
        email_code_cooldown_seconds=int(os.environ.get("RESCENE_EMAIL_CODE_COOLDOWN_SECONDS", "60")),
        email_code_hourly_limit=int(os.environ.get("RESCENE_EMAIL_CODE_HOURLY_LIMIT", "5")),
        email_code_max_attempts=int(os.environ.get("RESCENE_EMAIL_CODE_MAX_ATTEMPTS", "5")),
    )
