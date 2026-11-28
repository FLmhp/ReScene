from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import hmac
import io
import ipaddress
import json
import logging
import math
import secrets
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from importlib.metadata import version as package_version
from pathlib import PurePosixPath, PureWindowsPath
from typing import Annotated, Literal, NoReturn

import jwt
import oss2
import segno
import uvicorn
from aliyunsdkcore.acs_exception.exceptions import ClientException, ServerException
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import and_, case, delete, func, or_, select, text, tuple_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from rescene.preprocess import IMAGE_SUFFIXES, VIDEO_SUFFIXES
from rescene_api.access_logging import LOGGING_CONFIG
from rescene_api.audit_data import redact_audit_metadata, safe_csv_cell
from rescene_api.auth import (
    decode_token,
    generate_email_code,
    hash_email_code,
    hash_password,
    issue_token,
    verify_password,
)
from rescene_api.avatar import AvatarTooLarge, InvalidAvatar, normalize_avatar
from rescene_api.bodylimit import RequestBodyLimitMiddleware
from rescene_api.config import settings
from rescene_api.db import SessionLocal, init_db
from rescene_api.email import deliver_email_code, smtp_configured
from rescene_api.models import (
    Announcement,
    Artifact,
    Asset,
    AssetCleanup,
    AuditLog,
    EmailAuthCode,
    IdempotencyRecord,
    JobLog,
    JobStage,
    Notification,
    NotificationEmailOutbox,
    Project,
    ProjectInvitation,
    ProjectMember,
    Reconstruction,
    ReconstructionJob,
    ReservedLoginKey,
    Share,
    User,
    UserAvatar,
    WorkerNode,
    now,
)
from rescene_api.notification_outbox import run_outbox
from rescene_api.notifications import (
    announcement_counts,
    notification_scope,
    notify,
    publish_announcement_notifications,
)
from rescene_api.ratelimit import limiter
from rescene_api.schemas import (
    AcceptInvitationRequest,
    AddMemberRequest,
    AvatarUploadRequest,
    ChangePasswordRequest,
    CompleteAssetRequest,
    CompleteJobRequest,
    CreateAnnouncementRequest,
    CreateJobRequest,
    CreateProjectRequest,
    CreateShareRequest,
    CreateUserRequest,
    EmailCodeLoginRequest,
    EmailCodeRequest,
    EmailPasswordResetRequest,
    FailJobRequest,
    HeartbeatRequest,
    LoginRequest,
    MarkNotificationsRequest,
    NotificationEmailConfirmation,
    NotificationEmailRequest,
    NotificationPreferencesPatch,
    RegisterRequest,
    ResetPasswordRequest,
    StageUpdate,
    UpdateMemberRequest,
    UpdateProfileRequest,
    UpdateUserRequest,
    UploadSessionRequest,
    WorkerLogsRequest,
)
from rescene_api.storage import POST_OBJECT_LIMIT, POST_OBJECT_TTL_SECONDS, OssStorage, credentials_dict
from rescene_api.username import UsernameValidationError, escape_like, legacy_email_key, normalize_username

bearer = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)


def fail(
    status_code: int,
    detail: str,
    code: str,
    headers: dict[str, str] | None = None,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise an HTTP error carrying a stable machine code for client mapping."""
    error = HTTPException(status_code, detail, headers={**(headers or {}), "X-Error-Code": code})
    if cause is not None:
        raise error from cause
    raise error


def client_address(request: Request) -> str:
    """Rate-limit identity from the hop Caddy vouches for, never the XFF chain.

    Caddy overwrites `X-Real-IP` with the client address resolved through its
    trusted-proxy list, so the value cannot be chosen by the caller. Direct API
    exposure is unsupported.
    """
    forwarded = request.headers.get("x-real-ip", "").strip()
    if forwarded:
        try:
            return ipaddress.ip_address(forwarded).compressed
        except ValueError:
            logger.warning("Ignoring malformed X-Real-IP %r", forwarded[:64])
    return request.client.host if request.client else "unknown"


def rate_limit(request: Request) -> None:
    """Cap credential attempts per client and route."""
    config = settings()
    key = f"{client_address(request)}:{request.url.path}"
    retry = limiter.allow(key, config.auth_rate_limit, 60)
    if retry is not None:
        fail(429, "Too many requests", "auth.rate_limited", {"Retry-After": str(math.ceil(retry))})


def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


Db = Annotated[Session, Depends(db_session)]


def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Db,
) -> User:
    if not credentials:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing access token")
    try:
        user_id, token_version = decode_token(credentials.credentials)
    except jwt.PyJWTError as error:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid access token") from error
    user = db.get(User, user_id)
    if not user or not user.active or user.token_version != token_version:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session is no longer valid")
    return user


UserDep = Annotated[User, Depends(current_user)]


def require_admin(user: UserDep) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator access required")
    return user


AdminDep = Annotated[User, Depends(require_admin)]


def require_worker(
    worker_id: Annotated[str, Header(alias="X-Worker-Id")],
    authorization: Annotated[str, Header(alias="Authorization")],
) -> str:
    expected = f"Bearer {settings().worker_token}"
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid worker token")
    return worker_id


WorkerDep = Annotated[str, Depends(require_worker)]
LeaseAttempt = Annotated[int, Header(alias="X-Lease-Attempt", ge=1)]


def effective_role(db: Session, project: Project, user: User) -> str | None:
    if project.owner_id == user.id:
        return "owner"
    if user.is_admin:
        return "admin"
    role = db.scalar(
        select(ProjectMember.role).where(ProjectMember.project_id == project.id, ProjectMember.user_id == user.id)
    )
    return role if role in {"member", "viewer"} else None


def project_for_user(db: Session, project_id: str, user: User, *, write: bool = False, lock: bool = False) -> Project:
    if lock:
        project = db.scalar(
            select(Project).where(Project.id == project_id).with_for_update().execution_options(populate_existing=True)
        )
    else:
        project = db.get(Project, project_id)
    if not project or project.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    role = effective_role(db, project, user)
    if role is None or (write and role not in {"owner", "admin", "member"}):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Project access denied")
    return project


def require_project_manager(project: Project, user: User) -> None:
    if project.owner_id != user.id and not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Project owner or administrator access required")


_UNRESOLVED = object()


def project_view(
    db: Session, project: Project, user: User, *, role: str | None | object = _UNRESOLVED
) -> dict[str, object]:
    """Serialize one project; list routes pass a role resolved in one batch."""
    effective = effective_role(db, project, user) if role is _UNRESOLVED else role
    return {
        "id": project.id,
        "name": project.name,
        "owner_id": project.owner_id,
        "effective_role": effective,
        "created_at": project.created_at,
    }


def user_view(user: User) -> dict[str, object]:
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "avatar_revision": user.avatar_revision,
        "is_admin": user.is_admin,
    }


def admin_user_view(user: User) -> dict[str, object]:
    return {
        **user_view(user),
        "active": user.active,
        "created_at": user.created_at,
    }


def storage() -> OssStorage:
    try:
        return OssStorage(settings())
    except RuntimeError as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from error


def audit(
    db: Session,
    actor_id: str | None,
    action: str,
    target_type: str,
    target_id: str,
    *,
    project_id: str | None = None,
    **metadata: object,
) -> None:
    db.add(
        AuditLog(
            actor_id=actor_id,
            project_id=project_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            metadata_json=redact_audit_metadata(metadata),
        )
    )


def bootstrap_admin() -> None:
    config = settings()
    if not config.admin_email or not config.admin_password_file:
        return
    password = config.admin_password_file.read_text(encoding="utf-8").strip()
    with SessionLocal() as db:
        if db.scalar(select(User).where(User.email == config.admin_email.lower())):
            return
        db.add(
            User(
                email=config.admin_email.lower(),
                password_hash=hash_password(password),
                is_admin=True,
            )
        )
        db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    bootstrap_admin()
    tasks = (asyncio.create_task(reap_expired_leases()), asyncio.create_task(run_outbox(SessionLocal)))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="ReScene API", version=package_version("rescene"), lifespan=lifespan)
app.add_middleware(RequestBodyLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings().cors_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "Last-Event-ID"],
    expose_headers=["X-Error-Code", "Retry-After"],
)


@app.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
def ready(db: Db) -> dict[str, str]:
    db.execute(select(1))
    return {"status": "ready"}


@app.post("/v1/auth/register", status_code=201)
def register(payload: RegisterRequest, db: Db, _: Annotated[None, Depends(rate_limit)] = None) -> dict[str, str]:
    """Create a self-service account and sign it in."""
    email = payload.email
    if db.scalar(select(User).where(User.email == email)):
        fail(status.HTTP_409_CONFLICT, "Email already registered", "auth.email_taken")
    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.flush()
        audit(db, user.id, "user.register", "user", user.id, email=email)
        db.commit()
    except IntegrityError:
        db.rollback()
        fail(status.HTTP_409_CONFLICT, "Email already registered", "auth.email_taken")
    db.refresh(user)
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


@app.post("/v1/auth/password")
def change_password(
    payload: ChangePasswordRequest,
    db: Db,
    user: UserDep,
    _: Annotated[None, Depends(rate_limit)] = None,
) -> dict[str, str]:
    """Rotate the signed-in account's password and retire every other session."""
    if not verify_password(payload.current_password, user.password_hash):
        fail(status.HTTP_400_BAD_REQUEST, "Current password is incorrect", "auth.password_mismatch")
    rotated = db.execute(
        update(User)
        .where(User.id == user.id, User.active.is_(True), User.password_hash == user.password_hash)
        .values(password_hash=hash_password(payload.new_password), token_version=User.token_version + 1)
    )
    if rotated.rowcount != 1:
        db.rollback()
        fail(status.HTTP_409_CONFLICT, "Account changed while the password was verified", "auth.session_stale")
    db.commit()
    db.refresh(user)
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


def _user_by_login_identifier(db: Session, identifier: str) -> User | None:
    """Resolve a login identifier without revealing whether it is an email or username."""
    email_key = legacy_email_key(identifier)
    user = db.scalar(select(User).where(User.email == email_key))
    if user is not None:
        return user
    if "@" in email_key:
        return None
    try:
        _, username_key = normalize_username(identifier)
    except UsernameValidationError:
        return None
    return db.scalar(select(User).where(User.username_key == username_key))


@app.post("/v1/auth/login")
def login(payload: LoginRequest, db: Db, _: Annotated[None, Depends(rate_limit)] = None) -> dict[str, str]:
    if payload.email is not None:
        user = db.scalar(select(User).where(User.email == payload.email))
    else:
        assert payload.identifier is not None
        user = _user_by_login_identifier(db, payload.identifier)
    if not user or not verify_password(payload.password, user.password_hash) or not user.active:
        fail(status.HTTP_401_UNAUTHORIZED, "Invalid credentials", "auth.invalid_credentials")
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


def utc(value: datetime) -> datetime:
    """SQLite returns naive timestamps; every stored value is UTC."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def email_code_user(db: Session, email: str) -> User | None:
    """Resolve the account a code may belong to; inactive accounts look absent."""
    user = db.scalar(select(User).where(User.email == email))
    return user if user is not None and user.active else None


def consume_email_code(db: Session, user: User, purpose: str, code: str) -> None:
    """Spend one live code and count the attempt; the caller commits the result."""
    config = settings()
    invalid_status = (
        status.HTTP_422_UNPROCESSABLE_ENTITY if purpose == "notification_verify" else status.HTTP_401_UNAUTHORIZED
    )
    record = db.scalar(
        select(EmailAuthCode)
        .where(
            EmailAuthCode.user_id == user.id,
            EmailAuthCode.purpose == purpose,
            EmailAuthCode.consumed_at.is_(None),
        )
        .order_by(EmailAuthCode.created_at.desc(), EmailAuthCode.id.desc())
        .limit(1)
    )
    current_time = now()
    if record is None or utc(record.expires_at) <= current_time:
        fail(invalid_status, "Verification code is invalid or expired", "auth.invalid_code")
    if record.attempts >= config.email_code_max_attempts:
        fail(status.HTTP_429_TOO_MANY_REQUESTS, "Too many code attempts", "auth.rate_limited")
    matched = hmac.compare_digest(record.code_hash, hash_email_code(user.id, purpose, code))
    values = {"attempts": EmailAuthCode.attempts + 1}
    if matched:
        values["consumed_at"] = current_time
    result = db.execute(
        update(EmailAuthCode)
        .where(
            EmailAuthCode.id == record.id,
            EmailAuthCode.consumed_at.is_(None),
            EmailAuthCode.attempts < config.email_code_max_attempts,
            EmailAuthCode.expires_at > current_time,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if not matched:
        db.commit()
    if not matched or result.rowcount != 1:
        fail(invalid_status, "Verification code is invalid or expired", "auth.invalid_code")


def issue_email_code(db: Session, user: User, purpose: str) -> str | None:
    """Replace a code after enforcing the per-account cooldown and hourly cap."""
    config = settings()
    issued = (
        db.scalar(
            select(func.count())
            .select_from(EmailAuthCode)
            .where(
                EmailAuthCode.user_id == user.id,
                EmailAuthCode.purpose == purpose,
                EmailAuthCode.created_at >= now() - timedelta(hours=1),
            )
        )
        or 0
    )
    latest = db.scalar(
        select(EmailAuthCode.created_at)
        .where(EmailAuthCode.user_id == user.id, EmailAuthCode.purpose == purpose)
        .order_by(EmailAuthCode.created_at.desc())
        .limit(1)
    )
    cooling = latest is not None and utc(latest) > now() - timedelta(seconds=config.email_code_cooldown_seconds)
    if issued >= config.email_code_hourly_limit or cooling:
        return None
    code = generate_email_code()
    db.execute(
        update(EmailAuthCode)
        .where(
            EmailAuthCode.user_id == user.id,
            EmailAuthCode.purpose == purpose,
            EmailAuthCode.consumed_at.is_(None),
        )
        .values(consumed_at=now())
        .execution_options(synchronize_session=False)
    )
    db.add(
        EmailAuthCode(
            user_id=user.id,
            purpose=purpose,
            code_hash=hash_email_code(user.id, purpose, code),
            expires_at=now() + timedelta(minutes=config.email_code_ttl_minutes),
        )
    )
    return code


@app.post("/v1/auth/email-code", status_code=status.HTTP_202_ACCEPTED)
def request_email_code(
    payload: EmailCodeRequest,
    db: Db,
    background: BackgroundTasks,
    _: Annotated[None, Depends(rate_limit)] = None,
) -> dict[str, str]:
    """Mail a login or reset code, answering identically for every address."""
    user = email_code_user(db, payload.email)
    if user is None or not lock_account(db, user, signed_in=False):
        return {"status": "accepted"}
    code = issue_email_code(db, user, payload.purpose)
    if code is None:
        return {"status": "accepted"}
    db.commit()
    background.add_task(deliver_email_code, user.email, code, payload.purpose)
    return {"status": "accepted"}


@app.post("/v1/auth/email-code/login")
def login_with_email_code(
    payload: EmailCodeLoginRequest, db: Db, _: Annotated[None, Depends(rate_limit)] = None
) -> dict[str, str]:
    """Exchange a live login code for a session; other sessions stay valid."""
    user = email_code_user(db, payload.email)
    if user is None or not lock_account(db, user, signed_in=False):
        fail(status.HTTP_401_UNAUTHORIZED, "Verification code is invalid or expired", "auth.invalid_code")
    consume_email_code(db, user, "login", payload.code)
    user.email_verified_at = now()
    audit(db, user.id, "auth.email_code_login", "user", user.id)
    db.commit()
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


@app.post("/v1/auth/password-reset")
def reset_password_with_email_code(
    payload: EmailPasswordResetRequest, db: Db, _: Annotated[None, Depends(rate_limit)] = None
) -> dict[str, str]:
    """Set a new password once a reset code checks out, retiring every old session."""
    user = email_code_user(db, payload.email)
    if user is None or not lock_account(db, user, signed_in=False):
        fail(status.HTTP_401_UNAUTHORIZED, "Verification code is invalid or expired", "auth.invalid_code")
    consume_email_code(db, user, "reset", payload.code)
    # Every outstanding code dies with the old password, so a leaked login code
    # cannot re-enter an account whose password was just reset.
    db.execute(
        update(EmailAuthCode)
        .where(EmailAuthCode.user_id == user.id, EmailAuthCode.consumed_at.is_(None))
        .values(consumed_at=now())
        .execution_options(synchronize_session=False)
    )
    rotated = db.execute(
        update(User)
        .where(User.id == user.id, User.active.is_(True), User.password_hash == user.password_hash)
        .values(
            password_hash=hash_password(payload.new_password),
            token_version=User.token_version + 1,
            email_verified_at=now(),
        )
    )
    if rotated.rowcount != 1:
        db.rollback()
        fail(status.HTTP_409_CONFLICT, "Account changed while the code was verified", "auth.session_stale")
    audit(db, user.id, "auth.password_reset", "user", user.id)
    db.commit()
    db.refresh(user)
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


@app.get("/v1/auth/me")
def get_me(user: UserDep) -> dict[str, object]:
    return user_view(user)


@app.patch("/v1/auth/me")
def update_profile(payload: UpdateProfileRequest, db: Db, user: UserDep) -> dict[str, object]:
    """Set or change the signed-in account's username."""
    try:
        display, key = normalize_username(payload.username)
    except UsernameValidationError as error:
        fail(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error), error.code)

    if db.get(ReservedLoginKey, key) is not None:
        fail(status.HTTP_409_CONFLICT, "Username is already taken", "auth.username_taken")

    user.username = display
    user.username_key = key
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        fail(status.HTTP_409_CONFLICT, "Username is already taken", "auth.username_taken")
    audit(db, user.id, "user.username.update", "user", user.id, username=display)
    db.commit()
    db.refresh(user)
    return user_view(user)


def lock_account(db: Session, user: User, *, signed_in: bool = True) -> bool:
    """Lock the user before touching codes or profile data across both databases."""
    identity = User.token_version == user.token_version if signed_in else User.email == user.email
    valid_session = (User.id == user.id, User.active.is_(True), identity)
    if db.get_bind().dialect.name == "sqlite":
        found = db.execute(update(User).where(*valid_session).values(token_version=User.token_version)).rowcount == 1
    else:
        found = db.scalar(select(User.id).where(*valid_session).with_for_update()) is not None
    if not found:
        if not signed_in:
            return False
        fail(status.HTTP_401_UNAUTHORIZED, "Session is no longer valid", "auth.session_stale")
    db.refresh(user)
    return True


@app.post("/v1/auth/me/avatar")
def set_avatar(payload: AvatarUploadRequest, db: Db, user: UserDep) -> dict[str, object]:
    """Store only a small, normalized avatar for the signed-in account."""
    try:
        jpeg = normalize_avatar(payload.image_base64)
    except AvatarTooLarge as error:
        fail(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(error), "avatar.too_large")
    except InvalidAvatar as error:
        fail(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error), "avatar.invalid_image")
    revision = hashlib.sha256(jpeg).hexdigest()
    lock_account(db, user)
    avatar = db.get(UserAvatar, user.id)
    if avatar is None:
        db.add(UserAvatar(user_id=user.id, jpeg_bytes=jpeg, revision=revision))
    elif avatar.revision != revision:
        avatar.jpeg_bytes = jpeg
        avatar.revision = revision
    audit(db, user.id, "user.avatar.update", "user", user.id)
    db.commit()
    return {**user_view(user), "avatar_revision": revision}


@app.delete("/v1/auth/me/avatar")
def remove_avatar(db: Db, user: UserDep) -> dict[str, object]:
    """Delete the account's avatar if one exists."""
    lock_account(db, user)
    deleted = db.execute(delete(UserAvatar).where(UserAvatar.user_id == user.id))
    if deleted.rowcount:
        audit(db, user.id, "user.avatar.remove", "user", user.id)
    db.commit()
    return {**user_view(user), "avatar_revision": None}


def notification_preferences_view(user: User) -> dict[str, bool]:
    return {
        "email_verified": user.email_verified_at is not None,
        "email_critical_announcements": user.email_critical_announcements,
        "email_job_results": user.email_job_results,
    }


@app.get("/v1/auth/me/notification-preferences")
def get_notification_preferences(user: UserDep) -> dict[str, bool]:
    return notification_preferences_view(user)


@app.patch("/v1/auth/me/notification-preferences")
def update_notification_preferences(payload: NotificationPreferencesPatch, db: Db, user: UserDep) -> dict[str, bool]:
    values = payload.model_dump(exclude_unset=True)
    lock_account(db, user)
    if user.email_verified_at is None and any(values.values()):
        fail(status.HTTP_409_CONFLICT, "Verify your email before subscribing", "notifications.email_unverified")
    changed = {key: value for key, value in values.items() if getattr(user, key) != value}
    for key, value in changed.items():
        setattr(user, key, value)
    if changed:
        audit(db, user.id, "user.notification_preferences.update", "user", user.id, **changed)
    db.commit()
    return notification_preferences_view(user)


@app.post("/v1/auth/me/email-verification", status_code=status.HTTP_202_ACCEPTED)
def request_notification_email_verification(
    db: Db,
    user: UserDep,
    background: BackgroundTasks,
    payload: NotificationEmailRequest | None = None,
    _: Annotated[None, Depends(rate_limit)] = None,
) -> dict[str, str]:
    if not smtp_configured(settings()):
        fail(status.HTTP_503_SERVICE_UNAVAILABLE, "Email verification is unavailable", "notifications.smtp_unavailable")
    lock_account(db, user)
    code = issue_email_code(db, user, "notification_verify")
    db.commit()
    if code is not None:
        background.add_task(deliver_email_code, user.email, code, "notification_verify")
    return {"status": "accepted"}


@app.post("/v1/auth/me/email-verification/confirm")
def confirm_notification_email_verification(
    payload: NotificationEmailConfirmation,
    db: Db,
    user: UserDep,
    _: Annotated[None, Depends(rate_limit)] = None,
) -> dict[str, bool]:
    lock_account(db, user)
    consume_email_code(db, user, "notification_verify", payload.code)
    user.email_verified_at = now()
    audit(db, user.id, "user.email.verify", "user", user.id)
    db.commit()
    return notification_preferences_view(user)


@app.post("/v1/auth/refresh")
def refresh(user: UserDep) -> dict[str, str]:
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


@app.post("/v1/auth/logout", status_code=204)
def logout(user: UserDep, db: Db) -> None:
    """Revoke the account's active sessions across devices."""
    db.execute(update(User).where(User.id == user.id).values(token_version=User.token_version + 1))
    db.commit()


@app.post("/v1/users", status_code=201)
def create_user(payload: CreateUserRequest, db: Db, admin: AdminDep) -> dict[str, object]:
    lock_governance_target(db, admin, admin.id)
    email = payload.email
    if db.scalar(select(User).where(User.email == email)):
        fail(status.HTTP_409_CONFLICT, "Email already registered", "auth.email_taken")
    user = User(email=email, password_hash=hash_password(payload.password), is_admin=payload.is_admin)
    db.add(user)
    try:
        db.flush()
        audit(db, admin.id, "user.create", "user", user.id, email=email, is_admin=user.is_admin)
        db.commit()
    except IntegrityError:
        db.rollback()
        fail(status.HTTP_409_CONFLICT, "Email already registered", "auth.email_taken")
    db.refresh(user)
    return user_view(user)


@app.get("/v1/users")
def list_users(
    admin: AdminDep,
    db: Db,
    query: str = "",
    active: bool | None = None,
    is_admin: bool | None = None,
    offset: int = 0,
    limit: int = 50,
) -> dict[str, object]:
    """Administrator account directory; matches username or email fragments."""
    if query.strip():
        term = f"%{escape_like(query.strip().lower())}%"
        filters = [
            or_(
                User.email.ilike(term, escape="\\"),
                User.username.ilike(term, escape="\\"),
            )
        ]
    else:
        filters = []
    if active is not None:
        filters.append(User.active.is_(active))
    if is_admin is not None:
        filters.append(User.is_admin.is_(is_admin))
    total = db.scalar(select(func.count()).select_from(User).where(*filters)) or 0
    rows = db.scalars(
        select(User).where(*filters).order_by(User.email).offset(max(0, offset)).limit(max(1, min(limit, 100)))
    ).all()
    return {"total": total, "items": [admin_user_view(item) for item in rows]}


@app.get("/v1/users/{user_id}")
def user_detail(user_id: str, db: Db, admin: AdminDep) -> dict[str, object]:
    """One account with every live project it owns or belongs to."""
    target = db.get(User, user_id)
    if not target:
        fail(status.HTTP_404_NOT_FOUND, "User not found", "user.not_found")
    memberships: dict[str, dict[str, object]] = {}
    for project in db.scalars(select(Project).where(Project.owner_id == user_id, Project.deleted_at.is_(None))).all():
        memberships[project.id] = {"project_id": project.id, "name": project.name, "role": "owner"}
    for member, name in db.execute(
        select(ProjectMember, Project.name)
        .join(Project, Project.id == ProjectMember.project_id)
        .where(ProjectMember.user_id == user_id, Project.deleted_at.is_(None))
        .order_by(Project.name)
    ).all():
        memberships.setdefault(member.project_id, {"project_id": member.project_id, "name": name, "role": member.role})
    return {**admin_user_view(target), "memberships": list(memberships.values())}


@app.get("/v1/users/{user_id}/avatar")
def get_avatar(user_id: str, db: Db, user: UserDep, response: Response) -> dict[str, str]:
    """Return a private thumbnail only to its owner or a platform administrator."""
    if user.id != user_id and not user.is_admin:
        fail(status.HTTP_403_FORBIDDEN, "Avatar access denied", "avatar.forbidden")
    image = db.execute(
        select(UserAvatar.jpeg_bytes, UserAvatar.revision).where(UserAvatar.user_id == user_id)
    ).one_or_none()
    if image is None:
        fail(status.HTTP_404_NOT_FOUND, "Avatar not found", "avatar.not_found")
    response.headers["Cache-Control"] = "private, no-store"
    return {"image_base64": base64.b64encode(image.jpeg_bytes).decode("ascii"), "revision": image.revision}


def lock_governance_target(db: Session, admin: User, target_id: str) -> User:
    """Recheck authorization while locking both participants in a stable order."""
    expected_version = admin.token_version
    if db.get_bind().dialect.name == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))
    users = {
        row.id: row
        for row in db.scalars(
            select(User)
            .where(User.id.in_({admin.id, target_id}))
            .order_by(User.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }
    actor = users.get(admin.id)
    if actor is None or not actor.active or actor.token_version != expected_version:
        fail(status.HTTP_401_UNAUTHORIZED, "Session is no longer valid", "auth.session_stale")
    if not actor.is_admin:
        fail(status.HTTP_403_FORBIDDEN, "Administrator access required", "admin.forbidden")
    target = users.get(target_id)
    if target is None:
        fail(status.HTTP_404_NOT_FOUND, "User not found", "user.not_found")
    return target


@app.patch("/v1/users/{user_id}")
def update_user(user_id: str, payload: UpdateUserRequest, db: Db, admin: AdminDep) -> dict[str, object]:
    target = lock_governance_target(db, admin, user_id)
    if target.id == admin.id and (payload.active is False or payload.is_admin is False):
        fail(status.HTTP_409_CONFLICT, "Cannot lock the signed-in administrator", "admin.self_locked")
    changed = {}
    if payload.active is not None and payload.active != target.active:
        target.active = changed["active"] = payload.active
        if not target.active:
            target.token_version += 1
    if payload.is_admin is not None and payload.is_admin != target.is_admin:
        target.is_admin = changed["is_admin"] = payload.is_admin
    if changed:
        audit(db, admin.id, "user.update", "user", target.id, **changed)
    db.commit()
    return admin_user_view(target)


@app.post("/v1/users/{user_id}/password", status_code=204)
def reset_user_password(user_id: str, payload: ResetPasswordRequest, db: Db, admin: AdminDep) -> None:
    """Set a new initial password and revoke every session the account holds."""
    target = lock_governance_target(db, admin, user_id)
    target.password_hash = hash_password(payload.password)
    target.token_version += 1
    audit(db, admin.id, "user.password.reset", "user", target.id)
    db.commit()


ACTIVE_JOB_STATUSES = ("QUEUED", "LEASED", "RUNNING")
_COVER_SUFFIXES = tuple(sorted(IMAGE_SUFFIXES))


def project_summaries(db: Session, user: User) -> list[dict[str, object]]:
    """One fixed set of aggregate queries for every project the user can see.

    Counts, active flags, covers and latest jobs are resolved in batches so the
    project library stays flat as the number of cards grows.
    """
    membership_role = aliased(ProjectMember)
    query = (
        select(Project, membership_role.role)
        .outerjoin(
            membership_role,
            and_(membership_role.project_id == Project.id, membership_role.user_id == user.id),
        )
        .where(Project.deleted_at.is_(None))
    )
    if not user.is_admin:
        query = query.where(or_(Project.owner_id == user.id, membership_role.role.in_(["member", "viewer"])))
    rows = db.execute(query.order_by(Project.created_at.desc())).all()
    ids = [project.id for project, _ in rows]
    if not ids:
        return []

    asset_counts = dict(
        db.execute(
            select(Asset.project_id, func.count()).where(Asset.project_id.in_(ids)).group_by(Asset.project_id)
        ).all()
    )
    job_stats = {
        project_id: (count, bool(active))
        for project_id, count, active in db.execute(
            select(
                ReconstructionJob.project_id,
                func.count(),
                func.coalesce(func.sum(case((ReconstructionJob.status.in_(ACTIVE_JOB_STATUSES), 1), else_=0)), 0),
            )
            .where(ReconstructionJob.project_id.in_(ids))
            .group_by(ReconstructionJob.project_id)
        ).all()
    }

    cover_candidates = (
        select(
            Asset,
            func.row_number()
            .over(
                partition_by=Asset.project_id,
                order_by=(Asset.created_at.desc(), Asset.id.desc()),
            )
            .label("cover_rank"),
        )
        .where(
            Asset.project_id.in_(ids),
            Asset.status == "READY",
            or_(*(func.lower(Asset.filename).endswith(suffix) for suffix in _COVER_SUFFIXES)),
        )
        .subquery()
    )
    cover_asset = aliased(Asset, cover_candidates)
    covers = {
        asset.project_id: asset
        for asset in db.scalars(select(cover_asset).where(cover_candidates.c.cover_rank == 1)).all()
    }

    job_candidates = (
        select(
            ReconstructionJob,
            Reconstruction.id.label("reconstruction_id"),
            func.row_number()
            .over(
                partition_by=ReconstructionJob.project_id,
                order_by=(ReconstructionJob.created_at.desc(), ReconstructionJob.id.desc()),
            )
            .label("latest_rank"),
        )
        .outerjoin(Reconstruction, Reconstruction.job_id == ReconstructionJob.id)
        .where(ReconstructionJob.project_id.in_(ids))
        .subquery()
    )
    latest_job = aliased(ReconstructionJob, job_candidates)
    latest_jobs = {
        job.project_id: (job, reconstruction_id)
        for job, reconstruction_id in db.execute(
            select(latest_job, job_candidates.c.reconstruction_id).where(job_candidates.c.latest_rank == 1)
        ).all()
    }

    summaries: list[dict[str, object]] = []
    for project, member_role in rows:
        if project.owner_id == user.id:
            role = "owner"
        elif user.is_admin:
            role = "admin"
        else:
            role = member_role if member_role in {"member", "viewer"} else None
        job_count, has_active_jobs = job_stats.get(project.id, (0, False))
        cover = covers.get(project.id)
        latest = latest_jobs.get(project.id)
        summaries.append(
            {
                "id": project.id,
                "name": project.name,
                "owner_id": project.owner_id,
                "effective_role": role,
                "asset_count": asset_counts.get(project.id, 0),
                "job_count": job_count,
                "has_active_jobs": has_active_jobs,
                "cover": asset_summary(cover) if cover else None,
                "latest_job": job_view(latest[0], latest[1]) if latest else None,
            }
        )
    return summaries


@app.get("/v1/projects")
def list_projects(db: Db, user: UserDep, view: Literal["list", "summary"] = "list") -> list[dict[str, object]]:
    if view == "summary":
        return project_summaries(db, user)
    membership = select(ProjectMember.project_id).where(
        ProjectMember.user_id == user.id, ProjectMember.role.in_(["member", "viewer"])
    )
    query = select(Project).where(Project.deleted_at.is_(None))
    if not user.is_admin:
        query = query.where(or_(Project.owner_id == user.id, Project.id.in_(membership)))
    rows = db.scalars(query.order_by(Project.created_at.desc())).all()
    ids = [item.id for item in rows]
    memberships = (
        dict(
            db.execute(
                select(ProjectMember.project_id, ProjectMember.role).where(
                    ProjectMember.user_id == user.id, ProjectMember.project_id.in_(ids)
                )
            ).all()
        )
        if ids
        else {}
    )

    def role_for(project: Project) -> str | None:
        if project.owner_id == user.id:
            return "owner"
        if user.is_admin:
            return "admin"
        role = memberships.get(project.id)
        return role if role in {"member", "viewer"} else None

    return [project_view(db, item, user, role=role_for(item)) for item in rows]


IDEMPOTENCY_MAX_LENGTH = 128


def idempotency_digest(request: dict[str, object]) -> str:
    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def idempotency_record(db: Session, user_id: str, operation: str, scope: str, key: str) -> IdempotencyRecord | None:
    return db.scalar(
        select(IdempotencyRecord).where(
            IdempotencyRecord.user_id == user_id,
            IdempotencyRecord.operation == operation,
            IdempotencyRecord.scope == scope,
            IdempotencyRecord.key == key,
        )
    )


def replay_idempotent(record: IdempotencyRecord, digest: str) -> dict[str, object]:
    if not hmac.compare_digest(record.request_hash, digest):
        fail(
            status.HTTP_409_CONFLICT,
            "Idempotency key was already used for a different request",
            "idempotency.conflict",
        )
    return record.response_json


def idempotent_create(
    db: Session,
    user: User,
    *,
    operation: str,
    scope: str,
    key: str | None,
    request: dict[str, object],
    build: Callable[[], dict[str, object]],
) -> dict[str, object]:
    """Commit ``build()`` once per key and replay its response for retries.

    Without a key the call keeps the previous behaviour and always creates a row.
    """
    if key is None:
        result = build()
        db.commit()
        return result
    if not 1 <= len(key) <= IDEMPOTENCY_MAX_LENGTH:
        fail(status.HTTP_400_BAD_REQUEST, "Idempotency-Key must be 1-128 characters", "idempotency.invalid_key")
    digest = idempotency_digest(request)
    for _ in range(2):
        stored = idempotency_record(db, user.id, operation, scope, key)
        if stored is not None:
            return replay_idempotent(stored, digest)
        snapshot = jsonable_encoder(build())
        db.add(
            IdempotencyRecord(
                user_id=user.id,
                operation=operation,
                scope=scope,
                key=key,
                request_hash=digest,
                status_code=201,
                response_json=snapshot,
            )
        )
        try:
            db.commit()
        except IntegrityError:
            # Another request with this key won the insert; its response is authoritative.
            db.rollback()
            continue
        # Return the stored snapshot so a retry is byte-identical to this response.
        return snapshot
    stored = idempotency_record(db, user.id, operation, scope, key)
    if stored is not None:
        return replay_idempotent(stored, digest)
    fail(status.HTTP_409_CONFLICT, "Idempotency key is still being processed", "idempotency.conflict")


@app.post("/v1/projects", status_code=201)
def create_project(
    payload: CreateProjectRequest,
    db: Db,
    user: UserDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict[str, object]:
    name = payload.name.strip()

    def build() -> dict[str, object]:
        project = Project(owner_id=user.id, name=name)
        db.add(project)
        db.flush()
        audit(db, user.id, "project.create", "project", project.id, project_id=project.id)
        return project_view(db, project, user)

    return idempotent_create(
        db, user, operation="project.create", scope="", key=idempotency_key, request={"name": name}, build=build
    )


@app.patch("/v1/projects/{project_id}")
def update_project(project_id: str, payload: CreateProjectRequest, db: Db, user: UserDep) -> dict[str, object]:
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    project.name = payload.name
    audit(db, user.id, "project.rename", "project", project.id, project_id=project.id)
    db.commit()
    return project_view(db, project, user)


@app.get("/v1/projects/{project_id}")
def get_project(project_id: str, db: Db, user: UserDep, view: Literal["full", "summary"] = "full") -> dict[str, object]:
    project = project_for_user(db, project_id, user)
    summary = {
        "id": project.id,
        "name": project.name,
        "owner_id": project.owner_id,
        "effective_role": effective_role(db, project, user),
    }
    if view == "summary":
        job_filter = ReconstructionJob.project_id == project.id
        latest = db.execute(
            select(ReconstructionJob, Reconstruction.id)
            .outerjoin(Reconstruction, Reconstruction.job_id == ReconstructionJob.id)
            .where(job_filter)
            .order_by(ReconstructionJob.created_at.desc(), ReconstructionJob.id.desc())
            .limit(1)
        ).first()
        cover = db.scalar(
            select(Asset)
            .where(
                Asset.project_id == project.id,
                Asset.status == "READY",
                or_(*(func.lower(Asset.filename).endswith(suffix) for suffix in sorted(IMAGE_SUFFIXES))),
            )
            .order_by(Asset.created_at.desc(), Asset.id.desc())
            .limit(1)
        )
        return {
            **summary,
            "asset_count": db.scalar(select(func.count()).select_from(Asset).where(Asset.project_id == project.id)),
            "job_count": db.scalar(select(func.count()).select_from(ReconstructionJob).where(job_filter)),
            "has_active_jobs": bool(
                db.scalar(
                    select(ReconstructionJob.id)
                    .where(job_filter, ReconstructionJob.status.in_(["QUEUED", "LEASED", "RUNNING"]))
                    .limit(1)
                )
            ),
            "cover": asset_summary(cover) if cover else None,
            "latest_job": job_view(latest[0], latest[1]) if latest else None,
        }
    expire_stale_uploads(db, project)
    assets = db.scalars(select(Asset).where(Asset.project_id == project.id).order_by(Asset.created_at)).all()
    jobs = db.scalars(
        select(ReconstructionJob)
        .where(ReconstructionJob.project_id == project.id)
        .order_by(ReconstructionJob.created_at.desc())
    ).all()
    reconstructions = {
        row.job_id: row.id
        for row in db.scalars(select(Reconstruction).where(Reconstruction.project_id == project.id)).all()
    }
    return {
        **summary,
        "assets": [asset_summary(item) for item in assets],
        "jobs": [job_view(item, reconstructions.get(item.id)) for item in jobs],
    }


def asset_summary(asset: Asset) -> dict[str, object]:
    return {"id": asset.id, "filename": asset.filename, "size": asset.size, "status": asset.status}


def page_anchor(cursor: str) -> tuple[datetime, str]:
    try:
        timestamp, item_id = cursor.split("|", 1)
        date = datetime.fromisoformat(timestamp)
        if not item_id or len(item_id) > 36 or "|" in item_id:
            raise ValueError
        return date.astimezone(UTC) if date.tzinfo else date.replace(tzinfo=UTC), item_id
    except (ValueError, OverflowError):
        fail(422, "Invalid pagination cursor", "page.invalid_cursor")


def next_cursor(item: Asset | ReconstructionJob) -> str:
    return f"{item.created_at.isoformat()}|{item.id}"


PageLimit = Annotated[int, Query(ge=1, le=100)]
PageCursor = Annotated[str, Query(max_length=100)]


@app.get("/v1/projects/{project_id}/assets")
def list_project_assets(project_id: str, db: Db, user: UserDep, limit: PageLimit = 24, cursor: PageCursor = ""):
    project = project_for_user(db, project_id, user)
    expire_stale_uploads(db, project)
    query = select(Asset).where(Asset.project_id == project.id)
    if cursor:
        query = query.where(tuple_(Asset.created_at, Asset.id) < page_anchor(cursor))
    rows = db.scalars(query.order_by(Asset.created_at.desc(), Asset.id.desc()).limit(limit + 1)).all()
    return {
        "items": [asset_summary(row) for row in rows[:limit]],
        "next_cursor": next_cursor(rows[limit - 1]) if len(rows) > limit else None,
    }


@app.get("/v1/projects/{project_id}/jobs")
def list_project_jobs(project_id: str, db: Db, user: UserDep, limit: PageLimit = 24, cursor: PageCursor = ""):
    project = project_for_user(db, project_id, user)
    query = (
        select(ReconstructionJob, Reconstruction.id)
        .outerjoin(Reconstruction, Reconstruction.job_id == ReconstructionJob.id)
        .where(ReconstructionJob.project_id == project.id)
    )
    if cursor:
        query = query.where(tuple_(ReconstructionJob.created_at, ReconstructionJob.id) < page_anchor(cursor))
    rows = db.execute(
        query.order_by(ReconstructionJob.created_at.desc(), ReconstructionJob.id.desc()).limit(limit + 1)
    ).all()
    return {
        "items": [job_view(job, reconstruction_id) for job, reconstruction_id in rows[:limit]],
        "next_cursor": next_cursor(rows[limit - 1][0]) if len(rows) > limit else None,
    }


@app.get("/v1/projects/{project_id}/members")
def list_members(project_id: str, db: Db, user: UserDep) -> list[dict[str, str]]:
    project = project_for_user(db, project_id, user)
    owner = db.get(User, project.owner_id)
    members = db.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id, ProjectMember.user_id != project.owner_id)
        .order_by(User.email)
    ).all()
    return [{"user_id": owner.id, "email": owner.email, "role": "owner"}] + [
        {"user_id": member.user_id, "email": account.email, "role": member.role}
        for member, account in members
        if member.role in {"member", "viewer"}
    ]


@app.patch("/v1/projects/{project_id}/members/{user_id}")
def update_member(project_id: str, user_id: str, payload: UpdateMemberRequest, db: Db, user: UserDep) -> dict[str, str]:
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    if user_id == project.owner_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cannot alter the project owner")
    member = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id)
    )
    account = db.get(User, user_id)
    if not member or not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    member.role = payload.role
    audit(
        db,
        user.id,
        "project.member.update",
        "project",
        project_id,
        project_id=project_id,
        member_id=user_id,
        role=payload.role,
    )
    db.commit()
    return {"user_id": account.id, "email": account.email, "role": member.role}


@app.delete("/v1/projects/{project_id}/members/{user_id}", status_code=204)
def remove_member(project_id: str, user_id: str, db: Db, user: UserDep) -> None:
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    if user_id == project.owner_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cannot remove the project owner")
    member = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id)
    )
    if not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    db.delete(member)
    audit(db, user.id, "project.member.remove", "project", project_id, project_id=project_id, member_id=user_id)
    db.commit()


@app.post("/v1/projects/{project_id}/members", status_code=201)
def add_member(
    project_id: str, payload: AddMemberRequest, response: Response, db: Db, user: UserDep
) -> dict[str, object]:
    """Issue a one-time invitation or report the existing membership."""
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    email = payload.email
    account = db.scalar(select(User).where(User.email == email))
    if account and account.id == project.owner_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cannot alter the project owner")
    if account and account.active:
        existing = db.scalar(
            select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == account.id)
        )
        if existing:
            return {"status": "member", "user_id": account.id, "role": existing.role}

    invitation = db.scalar(
        select(ProjectInvitation).where(ProjectInvitation.project_id == project_id, ProjectInvitation.email == email)
    )
    if not invitation:
        invitation = ProjectInvitation(project_id=project_id, email=email)
        db.add(invitation)
    code = secrets.token_urlsafe(32)
    expires_at = now() + timedelta(days=7)
    invitation.role = payload.role
    invitation.invited_by = user.id
    invitation.claim_digest = hashlib.sha256(code.encode()).hexdigest()
    invitation.expires_at = expires_at
    audit(db, user.id, "project.member.invite", "project", project_id, project_id=project_id, email=email)
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"status": "invited", "email": email, "role": payload.role, "claim_code": code, "expires_at": expires_at}


@app.post("/v1/project-invitations/accept", dependencies=[Depends(rate_limit)])
def accept_invitation(payload: AcceptInvitationRequest, db: Db, user: UserDep) -> dict[str, str]:
    """Grant access once to the authenticated account matching an active invitation."""
    digest = hashlib.sha256(payload.code.encode()).hexdigest()
    project_id = db.scalar(select(ProjectInvitation.project_id).where(ProjectInvitation.claim_digest == digest))
    project = db.get(Project, project_id, with_for_update=True) if project_id else None
    if not project or project.deleted_at or project.owner_id == user.id:
        fail(status.HTTP_404_NOT_FOUND, "Invitation is unavailable", "invitation.unavailable")
    invitation = db.scalar(
        select(ProjectInvitation).where(
            ProjectInvitation.project_id == project.id,
            ProjectInvitation.claim_digest == digest,
            ProjectInvitation.email == user.email,
            ProjectInvitation.expires_at > now(),
        )
    )
    if not invitation:
        fail(status.HTTP_404_NOT_FOUND, "Invitation is unavailable", "invitation.unavailable")
    existing = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == user.id,
        )
    )
    role = existing.role if existing else invitation.role
    if not existing:
        db.add(ProjectMember(project_id=project.id, user_id=user.id, role=role))
    audit(
        db,
        user.id,
        "project.member.invite.accept",
        "project",
        project.id,
        project_id=project.id,
        email=user.email,
    )
    db.delete(invitation)
    db.commit()
    return {"project_id": project.id, "role": role}


@app.get("/v1/projects/{project_id}/invitations")
def list_invitations(project_id: str, db: Db, user: UserDep) -> list[dict[str, object]]:
    """List pending invitations without their claim credentials."""
    project = project_for_user(db, project_id, user)
    require_project_manager(project, user)
    rows = db.scalars(
        select(ProjectInvitation)
        .where(ProjectInvitation.project_id == project_id)
        .order_by(ProjectInvitation.created_at)
    ).all()
    return [{"id": row.id, "email": row.email, "role": row.role, "created_at": row.created_at} for row in rows]


@app.delete("/v1/projects/{project_id}/invitations/{invitation_id}", status_code=204)
def revoke_invitation(project_id: str, invitation_id: str, db: Db, user: UserDep) -> None:
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    invitation = db.get(ProjectInvitation, invitation_id)
    if not invitation or invitation.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invitation not found")
    db.delete(invitation)
    audit(
        db,
        user.id,
        "project.member.invite.revoke",
        "project",
        project_id,
        project_id=project_id,
        email=invitation.email,
    )
    db.commit()


def parse_audit_time(value: str, name: str) -> datetime:
    """Parse an ISO-8601 filter bound and normalize it to UTC so SQLite rows compare correctly."""
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC)
    except (ValueError, OverflowError):
        fail(422, f"Invalid {name} time", "audit.invalid_time")


def audit_filters(actor: str, action: str, project_id: str, since: str, until: str) -> list:
    """Translate the console's filter inputs into reusable WHERE clauses."""
    clauses = []
    if actor.strip():
        term = f"%{escape_like(actor.strip().lower())}%"
        clauses.append(or_(User.email.ilike(term, escape="\\"), User.username_key.like(term, escape="\\")))
    action = action.strip()
    if action.endswith("."):
        clauses.append(AuditLog.action.like(f"{escape_like(action)}%", escape="\\"))
    elif action:
        clauses.append(AuditLog.action == action)
    if project_id.strip():
        clauses.append(AuditLog.project_id == project_id.strip())
    start = parse_audit_time(since, "since") if since else None
    end = parse_audit_time(until, "until") if until else None
    if start is not None:
        clauses.append(AuditLog.created_at >= start)
    if end is not None:
        clauses.append(AuditLog.created_at <= end)
    if start is not None and end is not None and end < start:
        fail(422, "End time precedes start time", "audit.invalid_time")
    return clauses


def audit_view(log: AuditLog, email: str | None, username: str | None, project_name: str | None) -> dict[str, object]:
    return {
        "id": log.id,
        "actor_email": email,
        "actor_username": username,
        "action": log.action,
        "target_type": log.target_type,
        "target_id": log.target_id,
        "project_id": log.project_id,
        "project_name": project_name,
        "metadata": redact_audit_metadata(log.metadata_json),
        "created_at": log.created_at,
    }


@app.get("/v1/audit")
def global_audit(
    db: Db,
    admin: AdminDep,
    actor: str = "",
    action: str = "",
    project_id: str = "",
    since: str = "",
    until: str = "",
    offset: int = 0,
    limit: int = 50,
) -> dict[str, object]:
    """Platform-wide activity trail for administrators, newest first."""
    clauses = audit_filters(actor, action, project_id, since, until)
    total = (
        db.scalar(
            select(func.count()).select_from(AuditLog).outerjoin(User, User.id == AuditLog.actor_id).where(*clauses)
        )
        or 0
    )
    rows = db.execute(
        select(AuditLog, User.email, User.username, Project.name)
        .outerjoin(User, User.id == AuditLog.actor_id)
        .outerjoin(Project, Project.id == AuditLog.project_id)
        .where(*clauses)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
    ).all()
    return {"total": total, "items": [audit_view(log, email, username, name) for log, email, username, name in rows]}


@app.get("/v1/audit/actions")
def audit_actions(db: Db, admin: AdminDep) -> list[str]:
    """Every action name recorded so far, for the console's filter dropdown."""
    return list(db.scalars(select(AuditLog.action).distinct().order_by(AuditLog.action)).all())


@app.get("/v1/audit.csv")
def audit_csv(
    db: Db,
    admin: AdminDep,
    actor: str = "",
    action: str = "",
    project_id: str = "",
    since: str = "",
    until: str = "",
) -> Response:
    """Export the filtered trail as CSV, capped so one request cannot exhaust memory."""
    clauses = audit_filters(actor, action, project_id, since, until)
    rows = db.execute(
        select(AuditLog, User.email, Project.name)
        .outerjoin(User, User.id == AuditLog.actor_id)
        .outerjoin(Project, Project.id == AuditLog.project_id)
        .where(*clauses)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(10_000)
    ).all()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["time", "actor", "action", "target_type", "target_id", "project_id", "project_name", "metadata"])
    for log, email, name in rows:
        writer.writerow(
            safe_csv_cell(cell)
            for cell in (
                log.created_at.isoformat() if log.created_at else "",
                email or "",
                log.action,
                log.target_type,
                log.target_id,
                log.project_id or "",
                name or "",
                json.dumps(redact_audit_metadata(log.metadata_json), ensure_ascii=False, sort_keys=True),
            )
        )
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit.csv"'},
    )


@app.get("/v1/projects/{project_id}/audit")
def project_audit(
    project_id: str, db: Db, user: UserDep, action: str = "", offset: int = 0, limit: int = 50
) -> dict[str, object]:
    """Project-scoped activity trail, newest first; older rows predate scoping."""
    project = project_for_user(db, project_id, user)
    require_project_manager(project, user)
    clauses = [AuditLog.project_id == project_id, *audit_filters("", action, "", "", "")]
    total = (
        db.scalar(
            select(func.count()).select_from(AuditLog).outerjoin(User, User.id == AuditLog.actor_id).where(*clauses)
        )
        or 0
    )
    rows = db.execute(
        select(AuditLog, User.email, User.username)
        .outerjoin(User, User.id == AuditLog.actor_id)
        .where(*clauses)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
    ).all()
    return {"total": total, "items": [audit_view(log, email, username, project.name) for log, email, username in rows]}


@app.delete("/v1/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Db, user: UserDep) -> None:
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    active = db.scalar(
        select(ReconstructionJob.id)
        .where(
            ReconstructionJob.project_id == project_id, ReconstructionJob.status.in_(["QUEUED", "LEASED", "RUNNING"])
        )
        .limit(1)
    )
    if active:
        raise HTTPException(status.HTTP_409_CONFLICT, "Project has active jobs")
    project.deleted_at = now()
    audit(db, user.id, "project.delete", "project", project.id, project_id=project.id)
    db.commit()


def upload_grant(asset: Asset, mode: Literal["sts", "post"]) -> dict[str, object]:
    """Return the credential shape the calling runtime can actually use."""
    if mode == "post":
        if asset.size > POST_OBJECT_LIMIT:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "PostObject uploads are limited to 5 GiB")
        backend = storage()
        credentials = backend.upload_credentials(asset.object_key, f"upload-{asset.id}")
        return {
            "asset_id": asset.id,
            "object_key": asset.object_key,
            "mode": "post",
            "url": backend.post_target(),
            "fields": backend.post_fields(asset.object_key, asset.size, credentials),
            "expires_at": (now() + timedelta(seconds=POST_OBJECT_TTL_SECONDS)).isoformat(),
        }
    credentials = storage().upload_credentials(asset.object_key, f"upload-{asset.id}")
    return {
        "asset_id": asset.id,
        "object_key": asset.object_key,
        "mode": "sts",
        "oss": credentials_dict(credentials, settings()),
    }


@app.post("/v1/projects/{project_id}/assets/upload-session", status_code=201)
def create_upload_session(project_id: str, payload: UploadSessionRequest, db: Db, user: UserDep) -> dict[str, object]:
    project_for_user(db, project_id, user, write=True)
    filename = PureWindowsPath(payload.filename).name
    if (
        not filename
        or filename in {".", ".."}
        or any(char in filename for char in "*?\\/")
        or any(ord(char) < 32 for char in filename)
        or PurePosixPath(filename).suffix.lower() not in IMAGE_SUFFIXES | VIDEO_SUFFIXES
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid filename")
    if not payload.sha256:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Upload SHA-256 is required")
    if payload.mode == "post" and payload.size > POST_OBJECT_LIMIT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "PostObject uploads are limited to 5 GiB")
    asset = Asset(
        project_id=project_id,
        object_key="pending",
        filename=filename,
        size=payload.size,
        content_type=payload.content_type,
        sha256=payload.sha256,
    )
    db.add(asset)
    db.flush()
    asset.object_key = f"projects/{project_id}/assets/{asset.id}/original/{filename}"
    try:
        grant = upload_grant(asset, payload.mode)
    except (HTTPException, ClientException, ServerException, oss2.exceptions.OssError) as error:
        # The row only exists to mint its object key: keep it out of the database
        # until the client actually holds usable credentials.
        db.rollback()
        logger.warning("Could not issue upload credentials for project %s (%s)", project_id, type(error).__name__)
        fail(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Upload credentials are unavailable",
            "asset.upload_credentials_unavailable",
            {"Retry-After": "30"},
        )
    audit(db, user.id, "asset.upload.init", "asset", asset.id, project_id=project_id)
    db.commit()
    return grant


@app.post("/v1/assets/{asset_id}/complete")
def complete_asset(asset_id: str, payload: CompleteAssetRequest, db: Db, user: UserDep) -> dict[str, object]:
    asset = db.get(Asset, asset_id, with_for_update=True)
    if not asset:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    project_for_user(db, asset.project_id, user, write=True)
    if asset.status == "READY" and payload.size == asset.size and payload.sha256 == asset.sha256:
        return {"id": asset.id, "status": asset.status}
    try:
        actual_size, content_type = storage().head(asset.object_key)
    except oss2.exceptions.NotFound as error:
        fail(status.HTTP_409_CONFLICT, "Upload is not complete", "asset.upload_incomplete", cause=error)
    if actual_size != payload.size or actual_size != asset.size:
        fail(
            status.HTTP_409_CONFLICT,
            "Uploaded object size does not match",
            "asset.upload_size_mismatch",
        )
    if not payload.sha256 or (asset.sha256 and asset.sha256 != payload.sha256):
        fail(
            status.HTTP_409_CONFLICT,
            "Uploaded object hash does not match",
            "asset.upload_hash_mismatch",
        )
    asset.sha256 = payload.sha256
    asset.content_type = content_type or asset.content_type
    asset.status = "READY"
    audit(db, user.id, "asset.upload.complete", "asset", asset.id, project_id=asset.project_id)
    db.commit()
    return {"id": asset.id, "status": asset.status}


@app.post("/v1/assets/{asset_id}/upload-session")
def refresh_upload_session(
    asset_id: str, db: Db, user: UserDep, mode: Literal["sts", "post"] = "sts"
) -> dict[str, object]:
    asset = db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    project_for_user(db, asset.project_id, user, write=True)
    if asset.status != "UPLOADING":
        fail(status.HTTP_409_CONFLICT, "Asset is not awaiting upload", "asset.not_awaiting_upload")
    return upload_grant(asset, mode)


@app.delete("/v1/assets/{asset_id}", status_code=204)
def delete_asset(asset_id: str, db: Db, user: UserDep) -> None:
    """Remove one unused asset; the cleanup queue removes its object after commit."""
    asset = db.get(Asset, asset_id)
    if not asset:
        fail(status.HTTP_404_NOT_FOUND, "Asset not found", "asset.not_found")
    project_for_user(db, asset.project_id, user, write=True, lock=True)
    asset = db.get(Asset, asset_id, with_for_update=True, populate_existing=True)
    if not asset:
        fail(status.HTTP_404_NOT_FOUND, "Asset not found", "asset.not_found")
    if asset_referenced(db, asset):
        fail(status.HTTP_409_CONFLICT, "Asset is used by a job", "asset.in_use")
    audit(db, user.id, "asset.delete", "asset", asset.id, project_id=asset.project_id, filename=asset.filename)
    db.add(AssetCleanup(object_key=asset.object_key, reason="asset.delete"))
    db.delete(asset)
    db.commit()


@app.get("/v1/assets/{asset_id}/preview")
def asset_preview(asset_id: str, db: Db, user: UserDep) -> dict[str, str]:
    asset = db.get(Asset, asset_id)
    if not asset:
        fail(status.HTTP_404_NOT_FOUND, "Asset not found", "asset.not_found")
    project_for_user(db, asset.project_id, user)
    if asset.status != "READY" or PurePosixPath(asset.filename).suffix.lower() not in IMAGE_SUFFIXES:
        fail(status.HTTP_409_CONFLICT, "Image is not ready for preview", "asset.preview_unavailable")
    try:
        url = storage().signed_preview(asset.object_key)
    except (oss2.exceptions.OssError, ClientException) as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Image preview storage is unavailable") from error
    return {"url": url, "expires_at": (now() + timedelta(seconds=300)).isoformat()}


@app.post("/v1/projects/{project_id}/jobs", status_code=201)
def create_job(
    project_id: str,
    payload: CreateJobRequest,
    db: Db,
    user: UserDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict[str, object]:
    project_for_user(db, project_id, user, write=True, lock=True)

    def build() -> dict[str, object]:
        assets = db.scalars(
            select(Asset).where(
                Asset.project_id == project_id, Asset.id.in_(payload.asset_ids), Asset.status == "READY"
            )
        ).all()
        if len(assets) != len(set(payload.asset_ids)):
            fail(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "All assets must be ready and belong to the project",
                "job.invalid_inputs",
            )
        suffixes = [PurePosixPath(asset.filename).suffix.lower() for asset in assets]
        if not (
            all(suffix in IMAGE_SUFFIXES for suffix in suffixes)
            or (len(suffixes) == 1 and suffixes[0] in VIDEO_SUFFIXES)
        ):
            fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "Select a set of images or one video", "job.invalid_inputs")
        if sum(asset.size for asset in assets) > 8 * 1024**3:
            fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "Job inputs exceed 8 GiB", "job.invalid_inputs")
        job = ReconstructionJob(project_id=project_id, profile=payload.profile, status="QUEUED", created_by=user.id)
        db.add(job)
        db.flush()
        audit(db, user.id, "job.create", "job", job.id, project_id=project_id, asset_ids=payload.asset_ids)
        db.add(JobStage(job_id=job.id, stage="queued", status="success", message=json.dumps(payload.asset_ids)))
        return job_view(job)

    return idempotent_create(
        db,
        user,
        operation="job.create",
        scope=project_id,
        key=idempotency_key,
        request={"project_id": project_id, "profile": payload.profile, "asset_ids": sorted(payload.asset_ids)},
        build=build,
    )


def job_view(job: ReconstructionJob, reconstruction_id: str | None = None) -> dict[str, object]:
    return {
        "id": job.id,
        "project_id": job.project_id,
        "profile": job.profile,
        "status": job.status,
        "progress": job.progress,
        "current_stage": job.current_stage,
        "attempt": job.attempt,
        "cancel_requested": job.cancel_requested_at is not None,
        "error_code": job.error_code if job.status != "SUCCEEDED" else None,
        "error_message": job.error_message if job.status != "SUCCEEDED" else None,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "reconstruction_id": reconstruction_id,
    }


def notify_job_result(db: Session, job: ReconstructionJob) -> None:
    """Record a result only in the transaction that reaches a terminal state."""
    project = db.get(Project, job.project_id)
    succeeded = job.status == "SUCCEEDED"
    notify(
        db,
        {job.created_by, project.owner_id},
        kind="job.succeeded" if succeeded else "job.failed",
        title="重建已完成" if succeeded else "重建失败",
        body=f"项目「{project.name}」的重建已完成" if succeeded else (job.error_message or "重建失败")[:500],
        project_id=project.id,
        job_id=job.id,
    )


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, db: Db, user: UserDep) -> dict[str, object]:
    job = db.get(ReconstructionJob, job_id)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    project_for_user(db, job.project_id, user)
    reconstruction_id = db.scalar(select(Reconstruction.id).where(Reconstruction.job_id == job.id))
    return job_view(job, reconstruction_id)


@app.get("/v1/jobs/{job_id}/stages")
def job_stages(job_id: str, db: Db, user: UserDep) -> list[dict[str, object]]:
    """Every recorded stage of one job, oldest first, with its metrics."""
    job = db.get(ReconstructionJob, job_id)
    if not job:
        fail(status.HTTP_404_NOT_FOUND, "Job not found", "job.not_found")
    project_for_user(db, job.project_id, user)
    rows = db.scalars(
        select(JobStage).where(JobStage.job_id == job_id).order_by(JobStage.created_at, JobStage.id)
    ).all()
    return [
        {
            "id": row.id,
            "stage": row.stage,
            "status": row.status,
            "progress": row.progress,
            "message": row.message,
            "metrics": row.metrics,
            "created_at": row.created_at,
        }
        for row in rows
    ]


def announcement_view(row: Announcement, counts: dict[str, int]) -> dict[str, object]:
    return {
        "id": row.id,
        "title": row.title,
        "body": row.body,
        "level": row.level,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "recipient_count": counts.get("recipient_count", 0),
        "read_count": counts.get("read_count", 0),
        "mail_pending": counts.get("mail_pending", 0),
        "mail_accepted": counts.get("mail_accepted", 0),
        "mail_failed": counts.get("mail_failed", 0),
        "mail_unknown": counts.get("mail_unknown", 0),
    }


@app.post("/v1/announcements", status_code=201)
def create_announcement(
    payload: CreateAnnouncementRequest,
    db: Db,
    admin: AdminDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict[str, object]:
    """Publish an announcement and fan it out as one notification per active account."""

    def build() -> dict[str, object]:
        row = Announcement(title=payload.title, body=payload.body, level=payload.level, created_by=admin.id)
        db.add(row)
        db.flush()
        recipients, pending = publish_announcement_notifications(db, row)
        audit(db, admin.id, "announcement.publish", "announcement", row.id, recipients=recipients)
        return announcement_view(row, {"recipient_count": recipients, "mail_pending": pending})

    return idempotent_create(
        db,
        admin,
        operation="announcement.publish",
        scope="",
        key=idempotency_key,
        request=payload.model_dump(),
        build=build,
    )


@app.get("/v1/announcements")
def list_announcements(db: Db, admin: AdminDep, limit: int = 50, offset: int = 0) -> list[dict[str, object]]:
    """Published announcements, newest first."""
    rows = db.scalars(
        select(Announcement)
        .order_by(Announcement.created_at.desc(), Announcement.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
    ).all()
    counts = announcement_counts(db, [item.id for item in rows])
    return [announcement_view(item, counts.get(item.id, {})) for item in rows]


@app.delete("/v1/announcements/{announcement_id}", status_code=204)
def delete_announcement(announcement_id: str, db: Db, admin: AdminDep) -> None:
    """Retract an announcement and every notification it produced."""
    row = db.get(Announcement, announcement_id)
    if not row:
        fail(status.HTTP_404_NOT_FOUND, "Announcement not found", "announcement.not_found")
    if db.get_bind().dialect.name == "sqlite":
        # SQLite development installations do not enforce foreign keys by default.
        db.execute(
            delete(NotificationEmailOutbox).where(
                NotificationEmailOutbox.notification_id.in_(
                    select(Notification.id).where(Notification.announcement_id == announcement_id)
                )
            )
        )
    db.execute(delete(Notification).where(Notification.announcement_id == announcement_id))
    db.delete(row)
    audit(db, admin.id, "announcement.delete", "announcement", announcement_id)
    db.commit()


@app.get("/v1/jobs/{job_id}/logs")
def job_logs(
    job_id: str,
    db: Db,
    user: UserDep,
    after_id: int = 0,
    before_id: int = 0,
    level: str = "",
    limit: int = 200,
) -> dict[str, object]:
    """Worker output for one job: incremental tail, older pages, or a level filter."""
    job = db.get(ReconstructionJob, job_id)
    if not job:
        fail(status.HTTP_404_NOT_FOUND, "Job not found", "job.not_found")
    project_for_user(db, job.project_id, user)
    size = max(1, min(limit, 500))
    query = select(JobLog).where(JobLog.job_id == job_id)
    if level.strip():
        query = query.where(JobLog.level == level.strip())
    if after_id > 0:
        rows = db.scalars(query.where(JobLog.id > after_id).order_by(JobLog.id).limit(size)).all()
    else:
        if before_id > 0:
            query = query.where(JobLog.id < before_id)
        rows = list(reversed(db.scalars(query.order_by(JobLog.id.desc()).limit(size)).all()))
    return {
        "items": [
            {
                "id": row.id,
                "attempt": row.attempt,
                "level": row.level,
                "message": row.message,
                "created_at": row.created_at,
            }
            for row in rows
        ]
    }


@app.get("/v1/notifications")
def list_notifications(
    db: Db, user: UserDep, unread: int = 0, kind: str = "", offset: int = 0, limit: int = 50
) -> list[dict[str, object]]:
    """Newest notifications for the signed-in account, optionally unread or type filtered."""
    query = (
        select(Notification, Announcement.level)
        .outerjoin(Announcement, Announcement.id == Notification.announcement_id)
        .where(notification_scope(user))
    )
    if unread:
        query = query.where(Notification.read_at.is_(None))
    if kind.strip():
        query = query.where(Notification.kind == kind.strip())
    rows = db.execute(
        query.order_by(Notification.created_at.desc(), Notification.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
    ).all()
    return [
        {
            "id": row.id,
            "kind": row.kind,
            "title": row.title,
            "body": row.body,
            "project_id": row.project_id,
            "job_id": row.job_id,
            "announcement_id": row.announcement_id,
            "announcement_level": level if row.kind == "announcement" else None,
            "read_at": row.read_at,
            "created_at": row.created_at,
        }
        for row, level in rows
    ]


@app.get("/v1/notifications/count")
def notification_count(db: Db, user: UserDep) -> dict[str, int]:
    """Unread badge count for the signed-in account."""
    unread = (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(notification_scope(user), Notification.read_at.is_(None))
        )
        or 0
    )
    return {"unread": unread}


@app.post("/v1/notifications/read")
def mark_notifications_read(payload: MarkNotificationsRequest, db: Db, user: UserDep) -> dict[str, int]:
    """Mark the listed notifications read, or every unread one when the list is empty."""
    query = update(Notification).where(notification_scope(user), Notification.read_at.is_(None))
    if payload.ids:
        query = query.where(Notification.id.in_(payload.ids))
    result = db.execute(query.values(read_at=now()))
    db.commit()
    return {"updated": result.rowcount or 0}


@app.get("/v1/workers/status")
def worker_status(db: Db, user: UserDep) -> dict[str, object]:
    cutoff = now() - timedelta(seconds=60)
    workers = db.scalars(select(WorkerNode).order_by(WorkerNode.last_seen_at.desc())).all()
    return {
        "online": any(item.last_seen_at >= cutoff for item in workers),
        "workers": [
            {
                "id": item.id,
                "gpu_name": item.gpu_name,
                "online": item.last_seen_at >= cutoff,
                "last_seen_at": item.last_seen_at,
            }
            for item in workers
        ],
    }


@app.post("/v1/jobs/{job_id}/cancel")
def cancel_job(job_id: str, db: Db, user: UserDep) -> dict[str, object]:
    job = db.get(ReconstructionJob, job_id, with_for_update=True)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    project_for_user(db, job.project_id, user, write=True)
    if job.status in {"SUCCEEDED", "FAILED", "CANCELLED"}:
        return job_view(job)
    job.cancel_requested_at = now()
    if job.status == "QUEUED":
        job.status = "CANCELLED"
    audit(db, user.id, "job.cancel", "job", job.id)
    db.commit()
    return job_view(job)


def requeue_job(job: ReconstructionJob, *, at: datetime | None = None) -> None:
    """Return a job to the queue without carrying the previous attempt's state.

    `resume_artifact_key` is intentionally preserved so the worker can resume
    from its checkpoint; only the fields an observer reads as "current" reset.
    """
    job.status = "QUEUED"
    job.progress = 0.0
    job.current_stage = None
    job.leased_by = None
    job.lease_expires_at = None
    job.heartbeat_at = None
    job.error_code = None
    job.error_message = None
    if at is not None:
        job.updated_at = at


@app.post("/v1/jobs/{job_id}/retry")
def retry_job(job_id: str, db: Db, user: UserDep) -> dict[str, object]:
    project_id = db.scalar(select(ReconstructionJob.project_id).where(ReconstructionJob.id == job_id))
    if not project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    project_for_user(db, project_id, user, write=True, lock=True)
    job = db.scalar(
        select(ReconstructionJob)
        .where(ReconstructionJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not job or job.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    if job.status not in {"FAILED", "CANCELLED"}:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only failed or cancelled jobs can be retried")
    if job.error_code == "INVALID_INPUT":
        fail(status.HTTP_409_CONFLICT, "Replace the invalid assets and create a new job", "job.invalid_input")
    job.max_attempts = job.attempt + 3
    requeue_job(job)
    job.cancel_requested_at = None
    audit(db, user.id, "job.retry", "job", job.id)
    db.commit()
    return job_view(job)


@app.get("/v1/jobs/{job_id}/events")
async def job_events(job_id: str, db: Db, user: UserDep, last_event_id: str = Query(default="", alias="lastEventId")):
    job = db.get(ReconstructionJob, job_id)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    project_for_user(db, job.project_id, user)
    cursor = None
    if last_event_id and last_event_id != "0":
        cursor_row = db.get(JobStage, last_event_id)
        if not cursor_row or cursor_row.job_id != job_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid event cursor")
        cursor = (cursor_row.created_at, cursor_row.id)
    db.close()

    async def stream():
        nonlocal cursor
        batch_size = 100
        while True:
            events = []
            terminal = False
            with SessionLocal() as session:
                current = session.get(ReconstructionJob, job_id)
                query = select(JobStage).where(JobStage.job_id == job_id)
                if cursor is not None:
                    query = query.where(
                        or_(
                            JobStage.created_at > cursor[0],
                            (JobStage.created_at == cursor[0]) & (JobStage.id > cursor[1]),
                        )
                    )
                rows = session.scalars(query.order_by(JobStage.created_at, JobStage.id).limit(batch_size)).all()
                for row in rows:
                    cursor = (row.created_at, row.id)
                    data = {
                        "stage": row.stage,
                        "status": row.status,
                        "progress": row.progress,
                        "message": row.message,
                        "metrics": row.metrics,
                    }
                    events.append(f"id: {row.id}\nevent: stage\ndata: {json.dumps(data, ensure_ascii=False)}\n\n")
                if len(rows) < batch_size and current and current.status in {"SUCCEEDED", "FAILED", "CANCELLED"}:
                    reconstruction_id = session.scalar(select(Reconstruction.id).where(Reconstruction.job_id == job_id))
                    events.append(
                        f"event: final\ndata: {json.dumps(job_view(current, reconstruction_id), default=str)}\n\n"
                    )
                    terminal = True
            for event in events:
                yield event
            if terminal:
                return
            if len(rows) == batch_size:
                continue
            yield ": heartbeat\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


def queued_asset_ids(db: Session, job_id: str) -> list[str]:
    queued = db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.stage == "queued"))
    return json.loads(queued.message or "[]") if queued else []


def asset_referenced(db: Session, asset: Asset) -> bool:
    """A job input cannot be deleted: its bytes are what the worker reads."""
    messages = db.scalars(
        select(JobStage.message)
        .join(ReconstructionJob, ReconstructionJob.id == JobStage.job_id)
        .where(ReconstructionJob.project_id == asset.project_id, JobStage.stage == "queued")
    )
    for message in messages:
        try:
            asset_ids = json.loads(message or "[]")
        except (TypeError, ValueError):
            return True
        if not isinstance(asset_ids, list) or asset.id in asset_ids:
            return True
    return False


STALE_UPLOAD_BATCH = 20


def expire_stale_uploads(db: Session, project: Project) -> int:
    """Queue one bounded batch of abandoned uploads for the cleanup reaper.

    The row lock (and the re-check under it) is the same fence completion uses,
    so an upload that turns READY before this transaction locks it is skipped.
    No storage call happens here; the reaper owns deletion and its retries.
    """
    cutoff = now() - timedelta(seconds=settings().stale_upload_seconds)
    eligible = (Asset.project_id == project.id, Asset.status == "UPLOADING", Asset.created_at < cutoff)
    candidates = db.scalars(
        select(Asset.id).where(*eligible).order_by(Asset.created_at, Asset.id).limit(STALE_UPLOAD_BATCH)
    ).all()
    expired = 0
    for asset_id in candidates:
        asset = db.scalar(
            select(Asset)
            .where(Asset.id == asset_id, *eligible)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        if asset is None:
            continue
        existing = db.scalar(select(AssetCleanup).where(AssetCleanup.object_key == asset.object_key))
        if existing is None:
            db.add(AssetCleanup(object_key=asset.object_key, reason="asset.expire"))
        else:
            existing.reason = "asset.expire"
        audit(db, None, "asset.expire", "asset", asset_id, project_id=project.id)
        db.delete(asset)
        expired += 1
    if expired:
        db.commit()
    else:
        db.rollback()
    return expired


def recover_expired_leases(db: Session, current_time: datetime) -> None:
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(52492371)"))
    else:
        db.execute(text("BEGIN IMMEDIATE"))
    expired = db.scalars(
        select(ReconstructionJob)
        .where(
            ReconstructionJob.status.in_(["LEASED", "RUNNING"]),
            ReconstructionJob.lease_expires_at <= current_time,
        )
        .with_for_update()
    ).all()
    for job in expired:
        if job.cancel_requested_at:
            job.status = "CANCELLED"
        elif job.attempt < job.max_attempts:
            requeue_job(job, at=current_time)
        else:
            job.status = "FAILED"
        if job.status != "QUEUED":
            job.error_code = "WORKER_LEASE_EXPIRED"
            job.error_message = "Worker heartbeat expired"
        job.leased_by = None
        job.lease_expires_at = None
        job.updated_at = current_time
        if job.status == "FAILED":
            notify_job_result(db, job)


CLEANUP_BATCH = 50
CLEANUP_MAX_BACKOFF = 3600
CLEANUP_MAX_ATTEMPTS = 10


def reap_asset_cleanups(limit: int = CLEANUP_BATCH) -> int:
    """Delete queued objects in their own transaction and return how many finished.

    The asset row is already committed as removed, so a failure here only delays
    the bytes; a missing object means an earlier attempt succeeded. Records that
    keep failing stop being retried and stay visible for operators.
    """
    removed = 0
    with SessionLocal() as db:
        due = db.scalars(
            select(AssetCleanup)
            .where(AssetCleanup.next_attempt_at <= now(), AssetCleanup.attempts < CLEANUP_MAX_ATTEMPTS)
            .order_by(AssetCleanup.next_attempt_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).all()
        for record in due:
            try:
                with suppress(oss2.exceptions.NotFound, oss2.exceptions.NoSuchKey):
                    storage().delete(record.object_key)
            except (HTTPException, ClientException, ServerException, oss2.exceptions.OssError) as error:
                record.attempts += 1
                record.next_attempt_at = now() + timedelta(seconds=min(CLEANUP_MAX_BACKOFF, 60 * 2**record.attempts))
                record.last_error = f"{type(error).__name__}: {error}"[:500]
                if record.attempts >= CLEANUP_MAX_ATTEMPTS:
                    logger.error(
                        "Giving up deleting %s after %s attempts (%s)",
                        record.object_key,
                        record.attempts,
                        type(error).__name__,
                    )
                else:
                    logger.warning("Could not delete %s yet (%s)", record.object_key, type(error).__name__)
                continue
            db.delete(record)
            removed += 1
        stuck = db.scalar(
            select(func.count()).select_from(AssetCleanup).where(AssetCleanup.attempts >= CLEANUP_MAX_ATTEMPTS)
        )
        db.commit()
    if removed:
        logger.info("Removed %s queued objects", removed)
    if stuck:
        logger.error("%s object deletions are stuck after %s attempts", stuck, CLEANUP_MAX_ATTEMPTS)
    return removed


def reap_once() -> None:
    with SessionLocal.begin() as db:
        recover_expired_leases(db, now())
    reap_asset_cleanups()


async def reap_expired_leases() -> None:
    while True:
        await asyncio.sleep(30)
        try:
            await asyncio.to_thread(reap_once)
        except Exception:
            logger.exception("Could not recover expired reconstruction leases")


@app.post("/v1/worker/lease")
def lease_job(db: Db, worker_id: WorkerDep, gpu_name: Annotated[str | None, Header(alias="X-GPU-Name")] = None):
    current_time = now()
    recover_expired_leases(db, current_time)
    worker = db.get(WorkerNode, worker_id)
    if not worker:
        worker = WorkerNode(id=worker_id)
        db.add(worker)
    worker.status = "ONLINE"
    worker.gpu_name = gpu_name
    worker.last_seen_at = current_time
    db.flush()
    if db.scalar(select(ReconstructionJob.id).where(ReconstructionJob.status.in_(["LEASED", "RUNNING"])).limit(1)):
        db.commit()
        return {"job": None}
    job = db.scalar(
        select(ReconstructionJob)
        .where(ReconstructionJob.status == "QUEUED")
        .order_by(ReconstructionJob.priority.desc(), ReconstructionJob.created_at, ReconstructionJob.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    if not job:
        db.commit()
        return {"job": None}
    job.status = "LEASED"
    job.leased_by = worker_id
    job.attempt += 1
    job.error_code = None
    job.error_message = None
    asset_ids = queued_asset_ids(db, job.id)
    assets = db.scalars(select(Asset).where(Asset.id.in_(asset_ids), Asset.status == "READY")).all()
    assets_by_id = {item.id: item for item in assets}
    if set(assets_by_id) != set(asset_ids) or not assets_by_id:
        job.status = "FAILED"
        job.error_code = "INVALID_INPUT"
        job.error_message = "Job assets are no longer available"
        job.leased_by = None
        notify_job_result(db, job)
        db.commit()
        return {"job": None}
    credentials = storage().worker_credentials(job.project_id, job.id, job.attempt)
    job.heartbeat_at = now()
    job.lease_expires_at = job.heartbeat_at + timedelta(seconds=90)
    db.commit()
    return {
        "job": {
            "job_id": job.id,
            "project_id": job.project_id,
            "profile": job.profile,
            "attempt": job.attempt,
            "resume": bool(job.resume_artifact_key),
            "resume_artifact_key": job.resume_artifact_key,
            "assets": [
                {
                    "id": item.id,
                    "filename": item.filename,
                    "object_key": item.object_key,
                    "size": item.size,
                    "sha256": item.sha256,
                }
                for item in (assets_by_id[asset_id] for asset_id in dict.fromkeys(asset_ids))
            ],
            "output_prefix": attempt_prefix(job),
            "oss": credentials_dict(credentials, settings()),
        }
    }


def attempt_prefix(job: ReconstructionJob) -> str:
    """Scope job writes to the active lease attempt."""
    return f"projects/{job.project_id}/jobs/{job.id}/attempts/{job.attempt}/"


def leased_job(db: Session, job_id: str, worker_id: str, attempt: int, *, completed: bool = False) -> ReconstructionJob:
    """Lock and verify ownership before changing any job state."""
    if db.get_bind().dialect.name == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))
    job = db.get(ReconstructionJob, job_id, with_for_update=True)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    if job.leased_by != worker_id or job.attempt != attempt:
        raise HTTPException(status.HTTP_409_CONFLICT, "Worker does not hold this lease")
    if completed and job.status == "SUCCEEDED":
        return job
    if (
        job.status not in {"LEASED", "RUNNING"}
        or job.lease_expires_at is None
        or job.lease_expires_at.replace(tzinfo=UTC) <= now()
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "Worker lease has expired")
    return job


@app.post("/v1/worker/jobs/{job_id}/heartbeat")
def heartbeat(
    job_id: str, payload: HeartbeatRequest, db: Db, worker_id: WorkerDep, attempt: LeaseAttempt
) -> dict[str, object]:
    job = leased_job(db, job_id, worker_id, attempt)
    current_time = now()
    job.status = "RUNNING"
    if payload.stage is not None:
        job.progress = payload.progress
        job.current_stage = payload.stage
    job.heartbeat_at = current_time
    job.lease_expires_at = current_time + timedelta(seconds=90)
    worker = db.get(WorkerNode, worker_id)
    if worker:
        worker.last_seen_at = current_time
        worker.gpu_name = payload.gpu_name or worker.gpu_name
    db.commit()
    return {"cancel_requested": job.cancel_requested_at is not None}


@app.post("/v1/worker/jobs/{job_id}/stage")
def update_stage(
    job_id: str, payload: StageUpdate, db: Db, worker_id: WorkerDep, attempt: LeaseAttempt
) -> dict[str, str]:
    job = leased_job(db, job_id, worker_id, attempt)
    if payload.resume_artifact_key and not payload.resume_artifact_key.startswith(attempt_prefix(job) + "checkpoints/"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid checkpoint key")
    stage_metrics = {**payload.metrics, "attempt": attempt}
    previous = db.scalar(
        select(JobStage)
        .where(JobStage.job_id == job.id, JobStage.stage == payload.stage)
        .order_by(JobStage.created_at.desc())
        .limit(1)
    )
    if previous and (previous.status, previous.progress, previous.message, previous.metrics) == (
        payload.status,
        payload.progress,
        payload.message,
        stage_metrics,
    ):
        return {"status": "accepted"}
    job.current_stage = payload.stage
    job.progress = payload.progress
    if payload.resume_artifact_key:
        job.resume_artifact_key = payload.resume_artifact_key
    db.add(
        JobStage(
            job_id=job.id,
            stage=payload.stage,
            status=payload.status,
            progress=payload.progress,
            message=payload.message,
            metrics=stage_metrics,
        )
    )
    db.commit()
    return {"status": "accepted"}


@app.post("/v1/worker/jobs/{job_id}/logs")
def append_job_logs(job_id: str, payload: WorkerLogsRequest, db: Db, worker_id: WorkerDep) -> dict[str, int]:
    """Accept a batch of worker log lines for the lease holder and enforce the retention cap."""
    leased_job(db, job_id, worker_id, payload.attempt)
    db.add_all(
        [
            JobLog(job_id=job_id, attempt=payload.attempt, level=line.level, message=line.message)
            for line in payload.lines
        ]
    )
    db.flush()
    keep = settings().job_log_limit
    if keep > 0:
        cutoff = db.scalar(
            select(JobLog.id).where(JobLog.job_id == job_id).order_by(JobLog.id.desc()).offset(keep - 1).limit(1)
        )
        if cutoff is not None:
            db.execute(delete(JobLog).where(JobLog.job_id == job_id, JobLog.id < cutoff))
    db.commit()
    return {"accepted": len(payload.lines)}


@app.post("/v1/worker/jobs/{job_id}/complete")
def complete_job(
    job_id: str, payload: CompleteJobRequest, db: Db, worker_id: WorkerDep, attempt: LeaseAttempt
) -> dict[str, str]:
    job = leased_job(db, job_id, worker_id, attempt, completed=True)
    existing = db.scalar(select(Reconstruction).where(Reconstruction.job_id == job_id))
    if existing:
        recorded = db.scalars(select(Artifact).where(Artifact.reconstruction_id == existing.id)).all()
        if {item.kind: (item.object_key, item.sha256, item.size) for item in recorded} != {
            item.kind: (item.object_key, item.sha256, item.size) for item in payload.artifacts
        }:
            raise HTTPException(status.HTTP_409_CONFLICT, "Completion does not match the published artifacts")
        return {"reconstruction_id": existing.id}
    if job.cancel_requested_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Job cancellation is pending")
    if any(not item.object_key.startswith(attempt_prefix(job) + "artifacts/") for item in payload.artifacts):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid artifact key")
    kinds = {item.kind for item in payload.artifacts}
    if not {"metrics", "report", "spz", "ply"} <= kinds or len(kinds) != len(payload.artifacts):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Missing or duplicate artifacts")
    version = (
        db.scalar(select(func.count()).select_from(Reconstruction).where(Reconstruction.project_id == job.project_id))
        or 0
    ) + 1
    reconstruction = Reconstruction(
        project_id=job.project_id,
        job_id=job.id,
        version=version,
        quality_score=payload.quality_score,
    )
    db.add(reconstruction)
    db.flush()
    for item in payload.artifacts:
        db.add(Artifact(reconstruction_id=reconstruction.id, **item.model_dump()))
    job.status = "SUCCEEDED"
    job.error_code = None
    job.error_message = None
    job.progress = 1.0
    job.current_stage = "complete"
    job.lease_expires_at = None
    audit(db, None, "job.complete", "job", job.id, project_id=job.project_id, worker_id=worker_id)
    notify_job_result(db, job)
    db.commit()
    return {"reconstruction_id": reconstruction.id}


@app.post("/v1/worker/jobs/{job_id}/fail")
def fail_job(
    job_id: str, payload: FailJobRequest, db: Db, worker_id: WorkerDep, attempt: LeaseAttempt
) -> dict[str, object]:
    job = leased_job(db, job_id, worker_id, attempt)
    retry = payload.retryable and job.attempt < job.max_attempts and job.cancel_requested_at is None
    if job.cancel_requested_at:
        job.status = "CANCELLED"
    elif retry:
        requeue_job(job)
    else:
        job.status = "FAILED"
    if job.status != "QUEUED":
        job.error_code = payload.error_code
        job.error_message = payload.error_message
    job.leased_by = None
    job.lease_expires_at = None
    audit(db, None, "job.fail", "job", job.id, project_id=job.project_id, code=payload.error_code)
    if job.status == "FAILED":
        notify_job_result(db, job)
    db.commit()
    return {"status": job.status, "retry": retry}


@app.post("/v1/worker/jobs/{job_id}/credentials")
def renew_job_credentials(job_id: str, db: Db, worker_id: WorkerDep, attempt: LeaseAttempt) -> dict[str, str]:
    job = leased_job(db, job_id, worker_id, attempt)
    db.commit()
    credentials = storage().worker_credentials(job.project_id, job.id, attempt)
    return credentials_dict(credentials, settings())


@app.get("/v1/reconstructions/{reconstruction_id}/manifest")
def reconstruction_manifest(reconstruction_id: str, db: Db, user: UserDep) -> dict[str, object]:
    reconstruction = db.get(Reconstruction, reconstruction_id)
    if not reconstruction:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reconstruction not found")
    project_for_user(db, reconstruction.project_id, user)
    artifacts = db.scalars(select(Artifact).where(Artifact.reconstruction_id == reconstruction_id)).all()
    store = storage()
    return {
        "version": 1,
        "reconstruction_id": reconstruction.id,
        "artifacts": [
            {
                "kind": item.kind,
                "url": store.signed_get(item.object_key),
                "sha256": item.sha256,
                "size": item.size,
                "content_type": item.content_type,
            }
            for item in artifacts
        ],
    }


@app.get("/v1/reconstructions/{reconstruction_id}/shares")
def list_shares(reconstruction_id: str, db: Db, user: UserDep) -> list[dict[str, object]]:
    reconstruction = db.get(Reconstruction, reconstruction_id)
    if not reconstruction:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reconstruction not found")
    project_for_user(db, reconstruction.project_id, user, write=True)
    shares = db.scalars(select(Share).where(Share.reconstruction_id == reconstruction_id).order_by(Share.id)).all()
    return [{"id": share.id, "expires_at": share.expires_at, "revoked_at": share.revoked_at} for share in shares]


@app.post("/v1/reconstructions/{reconstruction_id}/shares", status_code=201)
def create_share(
    reconstruction_id: str,
    payload: CreateShareRequest,
    db: Db,
    user: UserDep,
) -> dict[str, object]:
    reconstruction = db.get(Reconstruction, reconstruction_id)
    if not reconstruction:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reconstruction not found")
    project_for_user(db, reconstruction.project_id, user, write=True)
    token = secrets.token_urlsafe(32)
    share = Share(
        reconstruction_id=reconstruction_id,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=payload.expires_at,
    )
    db.add(share)
    audit(db, user.id, "share.create", "reconstruction", reconstruction_id, project_id=reconstruction.project_id)
    db.commit()
    return {"id": share.id, "token": token, "expires_at": share.expires_at}


@app.delete("/v1/shares/{share_id}", status_code=204)
def revoke_share(share_id: str, db: Db, user: UserDep) -> None:
    share = db.get(Share, share_id)
    if not share:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Share not found")
    reconstruction = db.get(Reconstruction, share.reconstruction_id)
    project_for_user(db, reconstruction.project_id, user, write=True)
    share.revoked_at = now()
    audit(db, user.id, "share.revoke", "share", share.id, project_id=reconstruction.project_id)
    db.commit()


@app.get("/v1/public/shares/{token}")
def public_share(token: str, db: Db) -> dict[str, object]:
    share = db.scalar(select(Share).where(Share.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if not share or share.revoked_at or (share.expires_at and share.expires_at.replace(tzinfo=UTC) < now()):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Share not found")
    project = db.scalar(
        select(Project)
        .join(Reconstruction, Reconstruction.project_id == Project.id)
        .where(Reconstruction.id == share.reconstruction_id)
    )
    if not project or project.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Share not found")
    artifacts = db.scalars(select(Artifact).where(Artifact.reconstruction_id == share.reconstruction_id)).all()
    store = storage()
    return {
        "reconstruction_id": share.reconstruction_id,
        "artifacts": [
            {
                "kind": item.kind,
                "url": store.signed_get(item.object_key, expires=300),
                "sha256": item.sha256,
                "size": item.size,
            }
            for item in artifacts
        ],
    }


@app.get("/v1/public/shares/{token}/qr.png")
def share_qr(token: str, db: Db) -> Response:
    """PNG QR code for a share link; PNG because no client runtime renders SVG images."""
    share = db.scalar(select(Share).where(Share.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if not share or share.revoked_at or (share.expires_at and share.expires_at.replace(tzinfo=UTC) < now()):
        fail(status.HTTP_404_NOT_FOUND, "Share not found", "share.not_found")
    project = db.scalar(
        select(Project)
        .join(Reconstruction, Reconstruction.project_id == Project.id)
        .where(Reconstruction.id == share.reconstruction_id)
    )
    if not project or project.deleted_at is not None:
        fail(status.HTTP_404_NOT_FOUND, "Share not found", "share.not_found")
    url = f"{settings().public_web_url.rstrip('/')}/share/{token}"
    buffer = io.BytesIO()
    segno.make(url, error="m").save(buffer, kind="png", scale=6, border=2)
    return Response(
        content=buffer.getvalue(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


def run() -> None:
    uvicorn.run(
        "rescene_api.main:app",
        host="0.0.0.0",
        port=8000,
        workers=2,
        proxy_headers=False,
        log_config=LOGGING_CONFIG,
    )
