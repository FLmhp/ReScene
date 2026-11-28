from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

# Login must still accept accounts created before strict validation existed;
# new accounts/invitations use StrictEmail.
LoginEmail = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=320),
]
LoginIdentifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=320)]
StrictEmail = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=3,
        max_length=320,
        pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
    ),
]


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # New clients log in with a username or email; legacy clients send `email`.
    identifier: LoginIdentifier | None = None
    email: LoginEmail | None = Field(default=None)
    # Far above any legitimate password; keeps scrypt off arbitrarily long inputs.
    password: str = Field(min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_one_identifier(self) -> Self:
        supplied = self.model_fields_set.intersection({"email", "identifier"})
        if len(supplied) != 1 or (self.identifier is None and self.email is None):
            raise ValueError("Exactly one of identifier or email is required")
        return self


class UpdateProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str


class AvatarUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_base64: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=128)


class EmailCodeRequest(BaseModel):
    """Ask for a login or reset code; the response never reveals account existence."""

    email: LoginEmail
    purpose: Literal["login", "reset"]


class EmailCodeLoginRequest(BaseModel):
    email: LoginEmail
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class EmailPasswordResetRequest(BaseModel):
    email: LoginEmail
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    new_password: str = Field(min_length=12, max_length=128)


class NotificationPreferencesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email_critical_announcements: bool | None = Field(default=None, strict=True)
    email_job_results: bool | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def require_boolean_change(self) -> Self:
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Supply at least one boolean subscription preference")
        return self


class NotificationEmailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NotificationEmailConfirmation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")


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
    email: StrictEmail
    password: str = Field(min_length=12, max_length=128)


class CreateUserRequest(RegisterRequest):
    is_admin: bool = False


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class AddMemberRequest(BaseModel):
    email: StrictEmail
    role: Literal["member", "viewer"] = "member"


class AcceptInvitationRequest(BaseModel):
    code: str = Field(min_length=1, max_length=128)


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

    @field_validator("title", "body", "level", mode="before")
    @classmethod
    def strip_content(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class WorkerLogLine(BaseModel):
    level: Literal["debug", "info", "warning", "error"] = "info"
    message: str = Field(min_length=1, max_length=4000)


class WorkerLogsRequest(BaseModel):
    attempt: int = Field(ge=1)
    lines: list[WorkerLogLine] = Field(min_length=1, max_length=200)
