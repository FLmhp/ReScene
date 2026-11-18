from __future__ import annotations

import asyncio
import csv
import hashlib
import hmac
import io
import json
import math
import secrets
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from importlib.metadata import version as package_version
from pathlib import PurePosixPath, PureWindowsPath
from typing import Annotated, Literal, NoReturn

import jwt
import oss2
import segno
import uvicorn
from aliyunsdkcore.acs_exception.exceptions import ClientException
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from rescene.preprocess import IMAGE_SUFFIXES, VIDEO_SUFFIXES
from rescene_api.auth import decode_token, hash_password, issue_token, verify_password
from rescene_api.config import settings
from rescene_api.db import SessionLocal, init_db
from rescene_api.models import (
    Announcement,
    Artifact,
    Asset,
    AuditLog,
    JobLog,
    JobStage,
    Notification,
    Project,
    ProjectInvitation,
    ProjectMember,
    Reconstruction,
    ReconstructionJob,
    Share,
    User,
    WorkerNode,
    now,
)
from rescene_api.ratelimit import limiter
from rescene_api.schemas import (
    AddMemberRequest,
    ChangePasswordRequest,
    CompleteAssetRequest,
    CompleteJobRequest,
    CreateAnnouncementRequest,
    CreateJobRequest,
    CreateProjectRequest,
    CreateShareRequest,
    CreateUserRequest,
    FailJobRequest,
    HeartbeatRequest,
    LoginRequest,
    MarkNotificationsRequest,
    RegisterRequest,
    ResetPasswordRequest,
    StageUpdate,
    UpdateMemberRequest,
    UpdateUserRequest,
    UploadSessionRequest,
    WorkerLogsRequest,
)
from rescene_api.storage import POST_OBJECT_LIMIT, POST_OBJECT_TTL_SECONDS, OssStorage, credentials_dict

bearer = HTTPBearer(auto_error=False)


def fail(status_code: int, detail: str, code: str, headers: dict[str, str] | None = None) -> NoReturn:
    """Raise an HTTP error carrying a stable machine code for client mapping."""
    raise HTTPException(status_code, detail, headers={**(headers or {}), "X-Error-Code": code})


def rate_limit(request: Request) -> None:
    """Cap anonymous credential attempts per client and route."""
    config = settings()
    key = f"{request.client.host if request.client else 'unknown'}:{request.url.path}"
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


def project_view(db: Session, project: Project, user: User) -> dict[str, object]:
    return {
        "id": project.id,
        "name": project.name,
        "owner_id": project.owner_id,
        "effective_role": effective_role(db, project, user),
        "created_at": project.created_at,
    }


def admin_user_view(user: User) -> dict[str, object]:
    return {
        "id": user.id,
        "email": user.email,
        "is_admin": user.is_admin,
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
            metadata_json=metadata,
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
    yield


app = FastAPI(title="ReScene API", version=package_version("rescene"), lifespan=lifespan)
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
    """Create a self-service account, claim pending invitations, and sign it in."""
    email = payload.email.strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        fail(status.HTTP_409_CONFLICT, "Email already registered", "auth.email_taken")
    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.flush()
        audit(db, user.id, "user.register", "user", user.id, email=email)
        for invitation in db.scalars(select(ProjectInvitation).where(ProjectInvitation.email == email)).all():
            member = db.scalar(
                select(ProjectMember).where(
                    ProjectMember.project_id == invitation.project_id, ProjectMember.user_id == user.id
                )
            )
            if member:
                member.role = invitation.role
            else:
                db.add(ProjectMember(project_id=invitation.project_id, user_id=user.id, role=invitation.role))
            audit(
                db,
                user.id,
                "project.member.invite.accept",
                "project",
                invitation.project_id,
                project_id=invitation.project_id,
                email=email,
            )
            db.delete(invitation)
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
    user.password_hash = hash_password(payload.new_password)
    user.token_version += 1
    db.commit()
    db.refresh(user)
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


@app.post("/v1/auth/login")
def login(payload: LoginRequest, db: Db, _: Annotated[None, Depends(rate_limit)] = None) -> dict[str, str]:
    user = db.scalar(select(User).where(User.email == payload.email.strip().lower()))
    if not user or not verify_password(payload.password, user.password_hash) or not user.active:
        fail(status.HTTP_401_UNAUTHORIZED, "Invalid credentials", "auth.invalid_credentials")
    return {"access_token": issue_token(user.id, user.token_version), "token_type": "bearer"}


@app.get("/v1/auth/me")
def get_me(user: UserDep) -> dict[str, object]:
    return {"id": user.id, "email": user.email, "is_admin": user.is_admin}


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
    email = payload.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "User already exists")
    user = User(email=email, password_hash=hash_password(payload.password), is_admin=payload.is_admin)
    db.add(user)
    db.flush()
    audit(db, admin.id, "user.create", "user", user.id, email=email)
    db.commit()
    return {"id": user.id, "email": user.email, "is_admin": user.is_admin}


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
    """Administrator account directory; matches a case-insensitive email fragment."""
    filters = [User.email.ilike(f"%{query.strip().lower()}%")] if query.strip() else []
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


@app.patch("/v1/users/{user_id}")
def update_user(user_id: str, payload: UpdateUserRequest, db: Db, admin: AdminDep) -> dict[str, object]:
    target = db.get(User, user_id)
    if not target:
        fail(status.HTTP_404_NOT_FOUND, "User not found", "user.not_found")
    if target.id == admin.id and (payload.active is False or payload.is_admin is False):
        fail(status.HTTP_409_CONFLICT, "Cannot lock the signed-in administrator", "admin.self_locked")
    if payload.active is not None:
        target.active = payload.active
        if not payload.active:
            target.token_version += 1
    if payload.is_admin is not None:
        target.is_admin = payload.is_admin
    audit(db, admin.id, "user.update", "user", target.id, active=target.active, is_admin=target.is_admin)
    db.commit()
    return admin_user_view(target)


@app.post("/v1/users/{user_id}/password", status_code=204)
def reset_user_password(user_id: str, payload: ResetPasswordRequest, db: Db, admin: AdminDep) -> None:
    """Set a new initial password and revoke every session the account holds."""
    target = db.get(User, user_id)
    if not target:
        fail(status.HTTP_404_NOT_FOUND, "User not found", "user.not_found")
    target.password_hash = hash_password(payload.password)
    target.token_version += 1
    audit(db, admin.id, "user.password.reset", "user", target.id)
    db.commit()


@app.get("/v1/projects")
def list_projects(db: Db, user: UserDep) -> list[dict[str, object]]:
    membership = select(ProjectMember.project_id).where(
        ProjectMember.user_id == user.id, ProjectMember.role.in_(["member", "viewer"])
    )
    query = select(Project).where(Project.deleted_at.is_(None))
    if not user.is_admin:
        query = query.where(or_(Project.owner_id == user.id, Project.id.in_(membership)))
    rows = db.scalars(query.order_by(Project.created_at.desc())).all()
    return [project_view(db, item, user) for item in rows]


@app.post("/v1/projects", status_code=201)
def create_project(payload: CreateProjectRequest, db: Db, user: UserDep) -> dict[str, object]:
    project = Project(owner_id=user.id, name=payload.name.strip())
    db.add(project)
    db.flush()
    audit(db, user.id, "project.create", "project", project.id, project_id=project.id)
    db.commit()
    return project_view(db, project, user)


@app.patch("/v1/projects/{project_id}")
def update_project(project_id: str, payload: CreateProjectRequest, db: Db, user: UserDep) -> dict[str, object]:
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    project.name = payload.name
    audit(db, user.id, "project.rename", "project", project.id, project_id=project.id)
    db.commit()
    return project_view(db, project, user)


@app.get("/v1/projects/{project_id}")
def get_project(project_id: str, db: Db, user: UserDep) -> dict[str, object]:
    project = project_for_user(db, project_id, user)
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
        "id": project.id,
        "name": project.name,
        "owner_id": project.owner_id,
        "effective_role": effective_role(db, project, user),
        "assets": [
            {"id": item.id, "filename": item.filename, "size": item.size, "status": item.status} for item in assets
        ],
        "jobs": [job_view(item, reconstructions.get(item.id)) for item in jobs],
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
def add_member(project_id: str, payload: AddMemberRequest, db: Db, user: UserDep) -> dict[str, object]:
    """Add an existing account, or invite an email that has not registered yet."""
    project = project_for_user(db, project_id, user, lock=True)
    require_project_manager(project, user)
    email = payload.email.strip().lower()
    member_user = db.scalar(select(User).where(User.email == email, User.active.is_(True)))
    if not member_user:
        invitation = db.scalar(
            select(ProjectInvitation).where(
                ProjectInvitation.project_id == project_id, ProjectInvitation.email == email
            )
        )
        if invitation:
            invitation.role = payload.role
        else:
            db.add(ProjectInvitation(project_id=project_id, email=email, role=payload.role, invited_by=user.id))
        audit(db, user.id, "project.member.invite", "project", project_id, project_id=project_id, email=email)
        db.commit()
        return {"status": "invited", "email": email, "role": payload.role}
    if member_user.id == project.owner_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cannot alter the project owner")
    existing = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == member_user.id,
        )
    )
    if existing:
        existing.role = payload.role
    else:
        db.add(ProjectMember(project_id=project_id, user_id=member_user.id, role=payload.role))
    audit(
        db,
        user.id,
        "project.member.add",
        "project",
        project_id,
        project_id=project_id,
        member_id=member_user.id,
    )
    db.commit()
    return {"status": "member", "user_id": member_user.id, "role": payload.role}


@app.get("/v1/projects/{project_id}/invitations")
def list_invitations(project_id: str, db: Db, user: UserDep) -> list[dict[str, object]]:
    """Pending email invitations; they are consumed when the address registers."""
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
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Invalid {name} time", "audit.invalid_time")
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC)


def audit_filters(actor: str, action: str, project_id: str, since: str, until: str) -> list:
    """Translate the console's filter inputs into reusable WHERE clauses."""
    clauses = []
    if actor.strip():
        clauses.append(User.email.ilike(f"%{actor.strip().lower()}%"))
    if action.strip():
        clauses.append(
            AuditLog.action.like(f"{action.strip()}%") if action.endswith(".") else AuditLog.action == action
        )
    if project_id.strip():
        clauses.append(AuditLog.project_id == project_id)
    if since:
        clauses.append(AuditLog.created_at >= parse_audit_time(since, "since"))
    if until:
        clauses.append(AuditLog.created_at <= parse_audit_time(until, "until"))
    return clauses


def audit_view(log: AuditLog, email: str | None, project_name: str | None) -> dict[str, object]:
    return {
        "id": log.id,
        "actor_email": email,
        "action": log.action,
        "target_type": log.target_type,
        "target_id": log.target_id,
        "project_id": log.project_id,
        "project_name": project_name,
        "metadata": log.metadata_json,
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
        select(AuditLog, User.email, Project.name)
        .outerjoin(User, User.id == AuditLog.actor_id)
        .outerjoin(Project, Project.id == AuditLog.project_id)
        .where(*clauses)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
    ).all()
    return {"total": total, "items": [audit_view(log, email, name) for log, email, name in rows]}


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
            [
                log.created_at.isoformat() if log.created_at else "",
                email or "",
                log.action,
                log.target_type,
                log.target_id,
                log.project_id or "",
                name or "",
                json.dumps(log.metadata_json, ensure_ascii=False, sort_keys=True),
            ]
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
        select(AuditLog, User.email)
        .outerjoin(User, User.id == AuditLog.actor_id)
        .where(*clauses)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
    ).all()
    return {"total": total, "items": [audit_view(log, email, project.name) for log, email in rows]}


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
    audit(db, user.id, "asset.upload.init", "asset", asset.id, project_id=project_id)
    db.commit()
    return upload_grant(asset, payload.mode)


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
        raise HTTPException(status.HTTP_409_CONFLICT, "Upload is not complete") from error
    if actual_size != payload.size or actual_size != asset.size:
        raise HTTPException(status.HTTP_409_CONFLICT, "Uploaded object size does not match")
    if not payload.sha256 or (asset.sha256 and asset.sha256 != payload.sha256):
        raise HTTPException(status.HTTP_409_CONFLICT, "Uploaded object hash does not match")
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
        raise HTTPException(status.HTTP_409_CONFLICT, "Asset is not awaiting upload")
    return upload_grant(asset, mode)


@app.delete("/v1/assets/{asset_id}", status_code=204)
def delete_asset(asset_id: str, db: Db, user: UserDep) -> None:
    """Remove one unused asset together with its object."""
    asset = db.get(Asset, asset_id)
    if not asset:
        fail(status.HTTP_404_NOT_FOUND, "Asset not found", "asset.not_found")
    project_for_user(db, asset.project_id, user, write=True, lock=True)
    asset = db.get(Asset, asset_id, with_for_update=True, populate_existing=True)
    if not asset:
        fail(status.HTTP_404_NOT_FOUND, "Asset not found", "asset.not_found")
    if asset_referenced(db, asset):
        fail(status.HTTP_409_CONFLICT, "Asset is used by a job", "asset.in_use")
    try:
        with suppress(oss2.exceptions.NotFound):
            storage().delete(asset.object_key)
    except oss2.exceptions.AccessDenied as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Asset storage refused the deletion") from error
    audit(db, user.id, "asset.delete", "asset", asset.id, project_id=asset.project_id, filename=asset.filename)
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
def create_job(project_id: str, payload: CreateJobRequest, db: Db, user: UserDep) -> dict[str, object]:
    project_for_user(db, project_id, user, write=True, lock=True)
    assets = db.scalars(
        select(Asset).where(Asset.project_id == project_id, Asset.id.in_(payload.asset_ids), Asset.status == "READY")
    ).all()
    if len(assets) != len(set(payload.asset_ids)):
        fail(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "All assets must be ready and belong to the project",
            "job.invalid_inputs",
        )
    suffixes = [PurePosixPath(asset.filename).suffix.lower() for asset in assets]
    if not (
        all(suffix in IMAGE_SUFFIXES for suffix in suffixes) or (len(suffixes) == 1 and suffixes[0] in VIDEO_SUFFIXES)
    ):
        fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "Select a set of images or one video", "job.invalid_inputs")
    if sum(asset.size for asset in assets) > 8 * 1024**3:
        fail(status.HTTP_422_UNPROCESSABLE_ENTITY, "Job inputs exceed 8 GiB", "job.invalid_inputs")
    job = ReconstructionJob(project_id=project_id, profile=payload.profile, status="QUEUED", created_by=user.id)
    db.add(job)
    db.flush()
    audit(db, user.id, "job.create", "job", job.id, project_id=project_id, asset_ids=payload.asset_ids)
    db.add(JobStage(job_id=job.id, stage="queued", status="success", message=json.dumps(payload.asset_ids)))
    db.commit()
    return job_view(job)


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


def notify(
    db: Session,
    recipients: set[str | None],
    *,
    kind: str,
    title: str,
    body: str,
    project_id: str | None = None,
    job_id: str | None = None,
) -> None:
    """Queue one notification per distinct recipient; anonymous actors are skipped."""
    for user_id in recipients:
        if user_id:
            db.add(
                Notification(
                    user_id=user_id,
                    kind=kind,
                    title=title,
                    body=body,
                    project_id=project_id,
                    job_id=job_id,
                )
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


def announcement_view(row: Announcement) -> dict[str, object]:
    return {
        "id": row.id,
        "title": row.title,
        "body": row.body,
        "level": row.level,
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


@app.post("/v1/announcements", status_code=201)
def create_announcement(payload: CreateAnnouncementRequest, db: Db, admin: AdminDep) -> dict[str, object]:
    """Publish an announcement and fan it out as one notification per active account."""
    row = Announcement(title=payload.title.strip(), body=payload.body.strip(), level=payload.level, created_by=admin.id)
    db.add(row)
    db.flush()
    recipients = db.scalars(select(User.id).where(User.active.is_(True))).all()
    for user_id in recipients:
        db.add(
            Notification(
                user_id=user_id,
                kind="announcement",
                title=row.title,
                body=row.body,
                announcement_id=row.id,
            )
        )
    audit(db, admin.id, "announcement.publish", "announcement", row.id, recipients=len(recipients))
    db.commit()
    return announcement_view(row)


@app.get("/v1/announcements")
def list_announcements(db: Db, admin: AdminDep, limit: int = 50) -> list[dict[str, object]]:
    """Published announcements, newest first."""
    rows = db.scalars(
        select(Announcement).order_by(Announcement.created_at.desc()).limit(max(1, min(limit, 100)))
    ).all()
    return [announcement_view(item) for item in rows]


@app.delete("/v1/announcements/{announcement_id}", status_code=204)
def delete_announcement(announcement_id: str, db: Db, admin: AdminDep) -> None:
    """Retract an announcement and every notification it produced."""
    row = db.get(Announcement, announcement_id)
    if not row:
        fail(status.HTTP_404_NOT_FOUND, "Announcement not found", "announcement.not_found")
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
            {"id": row.id, "level": row.level, "message": row.message, "created_at": row.created_at} for row in rows
        ]
    }


@app.get("/v1/notifications")
def list_notifications(
    db: Db, user: UserDep, unread: int = 0, kind: str = "", offset: int = 0, limit: int = 50
) -> list[dict[str, object]]:
    """Newest notifications for the signed-in account, optionally unread or type filtered."""
    query = select(Notification).where(Notification.user_id == user.id)
    if unread:
        query = query.where(Notification.read_at.is_(None))
    if kind.strip():
        query = query.where(Notification.kind == kind.strip())
    rows = db.scalars(
        query.order_by(Notification.created_at.desc()).offset(max(0, offset)).limit(max(1, min(limit, 100)))
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
            "read_at": row.read_at,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@app.get("/v1/notifications/count")
def notification_count(db: Db, user: UserDep) -> dict[str, int]:
    """Unread badge count for the signed-in account."""
    unread = (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        )
        or 0
    )
    return {"unread": unread}


@app.post("/v1/notifications/read")
def mark_notifications_read(payload: MarkNotificationsRequest, db: Db, user: UserDep) -> dict[str, int]:
    """Mark the listed notifications read, or every unread one when the list is empty."""
    query = update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
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
    job.status = "QUEUED"
    job.max_attempts = job.attempt + 3
    job.error_code = None
    job.error_message = None
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
                rows = session.scalars(query.order_by(JobStage.created_at, JobStage.id)).all()
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
                if current and current.status in {"SUCCEEDED", "FAILED", "CANCELLED"}:
                    reconstruction_id = session.scalar(select(Reconstruction.id).where(Reconstruction.job_id == job_id))
                    events.append(
                        f"event: final\ndata: {json.dumps(job_view(current, reconstruction_id), default=str)}\n\n"
                    )
                    terminal = True
            for event in events:
                yield event
            if terminal:
                return
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
    job_ids = db.scalars(select(ReconstructionJob.id).where(ReconstructionJob.project_id == asset.project_id)).all()
    return any(asset.id in queued_asset_ids(db, job_id) for job_id in job_ids)


def expire_stale_uploads(db: Session, project: Project) -> None:
    """Drop uploads that were registered but never completed, so rows cannot leak."""
    cutoff = now() - timedelta(seconds=settings().stale_upload_seconds)
    stale = db.scalars(
        select(Asset).where(Asset.project_id == project.id, Asset.status == "UPLOADING", Asset.created_at < cutoff)
    ).all()
    if not stale:
        return
    try:
        store = storage()
    except HTTPException:
        store = None
    for asset in stale:
        asset_id = asset.id
        if store is not None:
            # The object was never written, or OSS rejects a missing key.
            with suppress(Exception):
                store.delete(asset.object_key)
        audit(db, None, "asset.expire", "asset", asset_id, project_id=project.id)
        db.delete(asset)
    db.commit()


@app.post("/v1/worker/lease")
def lease_job(db: Db, worker_id: WorkerDep, gpu_name: Annotated[str | None, Header(alias="X-GPU-Name")] = None):
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(52492371)"))
    current_time = now()
    expired = db.scalars(
        select(ReconstructionJob)
        .where(
            ReconstructionJob.status.in_(["LEASED", "RUNNING"]),
            ReconstructionJob.lease_expires_at < current_time,
        )
        .with_for_update()
    ).all()
    for job in expired:
        job.status = (
            "CANCELLED" if job.cancel_requested_at else "QUEUED" if job.attempt < job.max_attempts else "FAILED"
        )
        job.error_code = "WORKER_LEASE_EXPIRED"
        job.error_message = "Worker heartbeat expired"
        job.leased_by = None
        job.lease_expires_at = None
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
        .order_by(ReconstructionJob.priority.desc(), ReconstructionJob.created_at)
        .with_for_update(skip_locked=True)
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
        kept = db.scalars(select(JobLog.id).where(JobLog.job_id == job_id).order_by(JobLog.id.desc()).limit(keep)).all()
        if len(kept) == keep:
            db.execute(delete(JobLog).where(JobLog.job_id == job_id, JobLog.id < kept[-1]))
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
    project = db.get(Project, job.project_id)
    notify(
        db,
        {job.created_by, project.owner_id},
        kind="job.succeeded",
        title="重建已完成",
        body=f"项目「{project.name}」的重建已完成",
        project_id=project.id,
        job_id=job.id,
    )
    db.commit()
    return {"reconstruction_id": reconstruction.id}


@app.post("/v1/worker/jobs/{job_id}/fail")
def fail_job(
    job_id: str, payload: FailJobRequest, db: Db, worker_id: WorkerDep, attempt: LeaseAttempt
) -> dict[str, object]:
    job = leased_job(db, job_id, worker_id, attempt)
    retry = payload.retryable and job.attempt < job.max_attempts and job.cancel_requested_at is None
    job.status = "CANCELLED" if job.cancel_requested_at else "QUEUED" if retry else "FAILED"
    job.error_code = payload.error_code
    job.error_message = payload.error_message
    job.leased_by = None
    job.lease_expires_at = None
    audit(db, None, "job.fail", "job", job.id, project_id=job.project_id, code=payload.error_code)
    if job.status == "FAILED":
        project = db.get(Project, job.project_id)
        notify(
            db,
            {job.created_by, project.owner_id},
            kind="job.failed",
            title="重建失败",
            body=(payload.error_message or "重建失败")[:500],
            project_id=project.id,
            job_id=job.id,
        )
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
    uvicorn.run("rescene_api.main:app", host="0.0.0.0", port=8000, workers=2)
