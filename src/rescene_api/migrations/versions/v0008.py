"""Queue object deletion so bytes are only removed after the row is committed."""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    """Track object keys that still need their bytes removed from OSS."""
    op.create_table(
        "asset_cleanups",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("object_key", sa.Text(), nullable=False),
        sa.Column("reason", sa.String(length=40), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_asset_cleanups_object_key", "asset_cleanups", ["object_key"], unique=True)
    op.create_index("ix_asset_cleanups_next_attempt_at", "asset_cleanups", ["next_attempt_at"])


def downgrade() -> None:
    """Drop the queue; objects already deleted stay deleted."""
    op.drop_index("ix_asset_cleanups_next_attempt_at", table_name="asset_cleanups")
    op.drop_index("ix_asset_cleanups_object_key", table_name="asset_cleanups")
    op.drop_table("asset_cleanups")
