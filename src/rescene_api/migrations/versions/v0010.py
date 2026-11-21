"""Index job logs by job and id for tail and retention scans."""

from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade() -> None:
    """Let the tail read and retention cutoff walk one ordered index."""
    op.create_index("ix_job_logs_job_id_id", "job_logs", ["job_id", "id"])


def downgrade() -> None:
    """Fall back to the single-column job index."""
    op.drop_index("ix_job_logs_job_id_id", table_name="job_logs")
