"""Support server-side session revocation."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    """Give existing users a compatible initial session version."""
    op.add_column("users", sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"))
