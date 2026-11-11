from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=128)


class UpdateUserRequest(BaseModel):
    active: bool | None = None
    is_admin: bool | None = None

    @model_validator(mode="after")
    def require_change(self):
        if self.active is None and self.is_admin is None:
            raise ValueError("At least one field is required")
        return self


class ResetPasswordRequest(BaseModel):
    password: str = Field(min_length=12, max_length=128)


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=12, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def strip_email(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class CreateUserRequest(LoginRequest):
    password: str = Field(min_length=12)
    is_admin: bool = False


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class AddMemberRequest(BaseModel):
    email: str
    role: Literal["member", "viewer"] = "member"


class MarkNotificationsRequest(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=200)


class UpdateMemberRequest(BaseModel):
    role: Literal["member", "viewer"]


class UploadSessionRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=500)
    size: int = Field(gt=0, le=8 * 1024**3)
    content_type: str = Field(min_length=1, max_length=200)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    mode: Literal["sts", "post"] = "sts"


class CompleteAssetRequest(BaseModel):
    size: int = Field(gt=0)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class CreateJobRequest(BaseModel):
    profile: Literal["fast", "balanced", "quality"] = "balanced"
    asset_ids: list[str] = Field(min_length=1, max_length=500)


class StageUpdate(BaseModel):
    stage: str = Field(min_length=1, max_length=50)
    status: Literal["running", "success", "failed"]
    progress: float = Field(ge=0, le=1)
    message: str | None = Field(default=None, max_length=2000)
    metrics: dict = Field(default_factory=dict)
    resume_artifact_key: str | None = None


class HeartbeatRequest(BaseModel):
    progress: float = Field(ge=0, le=1)
    stage: str | None = Field(default=None, max_length=50)
    gpu_name: str | None = Field(default=None, max_length=200)


class ArtifactInput(BaseModel):
    kind: str = Field(min_length=1, max_length=50)
    object_key: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(gt=0)
    content_type: str = Field(min_length=1, max_length=200)


class CompleteJobRequest(BaseModel):
    artifacts: list[ArtifactInput] = Field(min_length=1)
    quality_score: float | None = None


class FailJobRequest(BaseModel):
    error_code: str = Field(min_length=1, max_length=100)
    error_message: str = Field(min_length=1, max_length=4000)
    retryable: bool = False


class CreateShareRequest(BaseModel):
    expires_at: datetime | None = None


class CreateAnnouncementRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=4000)
    level: Literal["info", "warning", "critical"] = "info"


class WorkerLogLine(BaseModel):
    level: Literal["debug", "info", "warning", "error"] = "info"
    message: str = Field(min_length=1, max_length=4000)


class WorkerLogsRequest(BaseModel):
    attempt: int = Field(ge=1)
    lines: list[WorkerLogLine] = Field(min_length=1, max_length=200)
