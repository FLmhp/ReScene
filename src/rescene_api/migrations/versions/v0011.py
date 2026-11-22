"""Store one-time email login and password-reset codes."""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade() -> None:
    """Keep only the digest, the attempt count and the lifetime of each code."""
    op.create_table(
        "email_auth_codes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(length=20), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_email_auth_codes_user_id", "email_auth_codes", ["user_id"])
    op.create_index("ix_email_auth_codes_created_at", "email_auth_codes", ["created_at"])
    op.create_index(
        "ix_email_auth_codes_user_id_purpose_created_at",
        "email_auth_codes",
        ["user_id", "purpose", "created_at"],
    )


def downgrade() -> None:
    """Drop issued codes; pending codes stop working."""
    op.drop_index("ix_email_auth_codes_user_id_purpose_created_at", table_name="email_auth_codes")
    op.drop_index("ix_email_auth_codes_created_at", table_name="email_auth_codes")
    op.drop_index("ix_email_auth_codes_user_id", table_name="email_auth_codes")
    op.drop_table("email_auth_codes")
