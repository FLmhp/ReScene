"""Add one-time claim credentials to project invitations."""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    """Retain pending invitations for reissue by project managers."""
    op.add_column("project_invitations", sa.Column("claim_digest", sa.String(length=64)))
    op.add_column("project_invitations", sa.Column("expires_at", sa.DateTime(timezone=True)))
    op.create_index("ix_project_invitations_claim_digest", "project_invitations", ["claim_digest"], unique=True)


def downgrade() -> None:
    """Remove invitation credentials while preserving the pending invitations."""
    op.drop_index("ix_project_invitations_claim_digest", table_name="project_invitations")
    op.drop_column("project_invitations", "expires_at")
    op.drop_column("project_invitations", "claim_digest")
