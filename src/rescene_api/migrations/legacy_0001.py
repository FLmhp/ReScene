"""Frozen schema of revision 0001; do not update for later migrations."""

import sqlalchemy as sa

metadata = sa.MetaData()


def table(name, columns, *constraints):
    return sa.Table(name, metadata, *columns, *constraints)


def col(name, kind, nullable=False):
    return sa.Column(name, kind, nullable=nullable)


def ident():
    return sa.Column("id", sa.String(36), primary_key=True)


def index(name, target, *columns, unique=False):
    sa.Index(name, *(target.c[column] for column in columns), unique=unique)


audit_logs = table(
    "audit_logs",
    [
        ident(),
        col("actor_id", sa.String(36), True),
        col("action", sa.String(100)),
        col("target_type", sa.String(50)),
        col("target_id", sa.String(100)),
        col("metadata_json", sa.JSON()),
        col("created_at", sa.DateTime(timezone=True)),
    ],
)
users = table(
    "users",
    [
        ident(),
        col("email", sa.String(320)),
        col("password_hash", sa.Text()),
        col("is_admin", sa.Boolean()),
        col("active", sa.Boolean()),
        col("created_at", sa.DateTime(timezone=True)),
    ],
)
worker_nodes = table(
    "worker_nodes",
    [
        sa.Column("id", sa.String(100), primary_key=True),
        col("status", sa.String(20)),
        col("gpu_name", sa.String(200), True),
        col("last_seen_at", sa.DateTime(timezone=True)),
    ],
)
projects = table(
    "projects",
    [
        ident(),
        col("owner_id", sa.String(36)),
        col("name", sa.String(200)),
        col("created_at", sa.DateTime(timezone=True)),
        col("deleted_at", sa.DateTime(timezone=True), True),
    ],
    sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
)
assets = table(
    "assets",
    [
        ident(),
        col("project_id", sa.String(36)),
        col("object_key", sa.Text()),
        col("filename", sa.String(500)),
        col("size", sa.BigInteger()),
        col("content_type", sa.String(200)),
        col("sha256", sa.String(64), True),
        col("status", sa.String(20)),
        col("created_at", sa.DateTime(timezone=True)),
    ],
    sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
    sa.UniqueConstraint("object_key"),
)
project_members = table(
    "project_members",
    [ident(), col("project_id", sa.String(36)), col("user_id", sa.String(36)), col("role", sa.String(20))],
    sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
    sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    sa.UniqueConstraint("project_id", "user_id"),
)
reconstruction_jobs = table(
    "reconstruction_jobs",
    [
        ident(),
        col("project_id", sa.String(36)),
        col("profile", sa.String(20)),
        col("status", sa.String(20)),
        col("priority", sa.Integer()),
        col("progress", sa.Float()),
        col("current_stage", sa.String(50), True),
        col("leased_by", sa.String(100), True),
        col("lease_expires_at", sa.DateTime(timezone=True), True),
        col("heartbeat_at", sa.DateTime(timezone=True), True),
        col("attempt", sa.Integer()),
        col("max_attempts", sa.Integer()),
        col("cancel_requested_at", sa.DateTime(timezone=True), True),
        col("resume_artifact_key", sa.Text(), True),
        col("error_code", sa.String(100), True),
        col("error_message", sa.Text(), True),
        col("created_at", sa.DateTime(timezone=True)),
        col("updated_at", sa.DateTime(timezone=True)),
    ],
    sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
)
job_stages = table(
    "job_stages",
    [
        ident(),
        col("job_id", sa.String(36)),
        col("stage", sa.String(50)),
        col("status", sa.String(20)),
        col("progress", sa.Float()),
        col("message", sa.Text(), True),
        col("metrics", sa.JSON()),
        col("created_at", sa.DateTime(timezone=True)),
    ],
    sa.ForeignKeyConstraint(["job_id"], ["reconstruction_jobs.id"], ondelete="CASCADE"),
)
reconstructions = table(
    "reconstructions",
    [
        ident(),
        col("project_id", sa.String(36)),
        col("job_id", sa.String(36)),
        col("version", sa.Integer()),
        col("status", sa.String(20)),
        col("quality_score", sa.Float(), True),
        col("created_at", sa.DateTime(timezone=True)),
    ],
    sa.ForeignKeyConstraint(["job_id"], ["reconstruction_jobs.id"]),
    sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
    sa.UniqueConstraint("job_id"),
)
artifacts = table(
    "artifacts",
    [
        ident(),
        col("reconstruction_id", sa.String(36)),
        col("kind", sa.String(50)),
        col("object_key", sa.Text()),
        col("sha256", sa.String(64)),
        col("size", sa.BigInteger()),
        col("content_type", sa.String(200)),
    ],
    sa.ForeignKeyConstraint(["reconstruction_id"], ["reconstructions.id"], ondelete="CASCADE"),
    sa.UniqueConstraint("reconstruction_id", "kind"),
)
shares = table(
    "shares",
    [
        ident(),
        col("reconstruction_id", sa.String(36)),
        col("token_hash", sa.String(64)),
        col("expires_at", sa.DateTime(timezone=True), True),
        col("revoked_at", sa.DateTime(timezone=True), True),
    ],
    sa.ForeignKeyConstraint(["reconstruction_id"], ["reconstructions.id"], ondelete="CASCADE"),
    sa.UniqueConstraint("token_hash"),
)

for target, columns in (
    (audit_logs, ("actor_id",)),
    (projects, ("owner_id",)),
    (assets, ("project_id", "status")),
    (project_members, ("project_id", "user_id")),
    (reconstruction_jobs, ("created_at", "lease_expires_at", "leased_by", "project_id", "status")),
    (job_stages, ("job_id",)),
    (reconstructions, ("job_id", "project_id")),
    (artifacts, ("reconstruction_id",)),
    (shares, ("reconstruction_id",)),
):
    for column in columns:
        index(f"ix_{target.name}_{column}", target, column)
index("ix_users_email", users, "email", unique=True)
