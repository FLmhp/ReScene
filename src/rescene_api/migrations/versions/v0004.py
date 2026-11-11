"""Drop the WeChat openid; sign-in is email + password only."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    """Remove the WeChat identity column and its unique index."""
    op.drop_index("ix_users_wechat_openid", table_name="users")
    op.drop_column("users", "wechat_openid")


def downgrade() -> None:
    """Restore the column so the previous revision still runs."""
    op.add_column("users", sa.Column("wechat_openid", sa.String(length=64), nullable=True))
    op.create_index("ix_users_wechat_openid", "users", ["wechat_openid"], unique=True)
