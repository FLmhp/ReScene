"""Add the Mini Program openid used for code-based login."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    """Link each WeChat account to exactly one ReScene account."""
    op.add_column("users", sa.Column("wechat_openid", sa.String(length=64), nullable=True))
    op.create_index("ix_users_wechat_openid", "users", ["wechat_openid"], unique=True)
