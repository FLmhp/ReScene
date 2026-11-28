"""Add usernames, avatars, verified email and the notification outbox.

This migration introduces:

- ``users.username`` and ``users.username_key`` for username/password login.
  ``username_key`` is NFKC/trimmed/ASCII-folded and backed by a unique index.
- ``users.email_verified_at`` plus the two notification subscription flags.
- ``user_avatars`` for the per-user cropped JPEG avatar.
- ``notification_email_outbox`` for reliable email delivery.
- ``reserved_login_keys`` which reserves normalized legacy non-``@`` email
  identifiers so they cannot be claimed as usernames.

Existing users, IDs, token versions and sessions are left untouched.
"""

import re
import unicodedata

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"

_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_USERNAME = re.compile(r"[\u4e00-\u9fff_a-z0-9-]{3,32}")
_LETTER_OR_DIGIT = re.compile(r"[\u4e00-\u9fffa-z0-9]")


def _normalize_login_key(value: str) -> str | None:
    """Return the normalized username-key form of *value* if it is eligible.

    The logic is pinned here so the migration remains stable even if the
    application-level validation changes later.  Only values that can match
    an allowed username are reserved; ``@`` and invalid forms are ignored.
    """
    normalized = unicodedata.normalize("NFKC", value).strip().translate(_ASCII_LOWER)
    if not _USERNAME.fullmatch(normalized) or not _LETTER_OR_DIGIT.search(normalized):
        return None
    return normalized


def upgrade() -> None:
    """Add identity and outbox tables; reserve historic non-@ login identifiers."""
    # User identity columns
    op.add_column("users", sa.Column("username", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("username_key", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users",
        sa.Column("email_critical_announcements", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "users",
        sa.Column("email_job_results", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_users_username_key", "users", ["username_key"], unique=True)

    # Per-user avatar storage
    op.create_table(
        "user_avatars",
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("jpeg_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("revision", sa.String(length=64), nullable=False),
    )

    # Outbox for notification emails
    op.create_table(
        "notification_email_outbox",
        sa.Column(
            "notification_id",
            sa.String(length=36),
            sa.ForeignKey("notifications.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_id", sa.String(length=36), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(length=100), nullable=True),
    )
    op.create_index(
        "ix_notification_email_outbox_state_next_attempt_at",
        "notification_email_outbox",
        ["state", "next_attempt_at"],
    )

    # Reserve normalized legacy non-@ email identifiers
    op.create_table(
        "reserved_login_keys",
        sa.Column("key", sa.String(length=32), primary_key=True),
    )

    connection = op.get_bind()
    rows = connection.execute(sa.text("SELECT email FROM users WHERE email NOT LIKE '%@%'"))
    keys = {_normalize_login_key(email) for (email,) in rows}
    keys.discard(None)

    if keys:
        params = [{"key": k} for k in sorted(keys)]
        if connection.dialect.name == "postgresql":
            connection.execute(
                sa.text("INSERT INTO reserved_login_keys (key) VALUES (:key) ON CONFLICT DO NOTHING"),
                params,
            )
        else:
            connection.execute(
                sa.text("INSERT OR IGNORE INTO reserved_login_keys (key) VALUES (:key)"),
                params,
            )


def downgrade() -> None:
    """Remove identity/outbox additions; reservation data is dropped."""
    op.drop_table("reserved_login_keys")
    op.drop_index(
        "ix_notification_email_outbox_state_next_attempt_at",
        table_name="notification_email_outbox",
    )
    op.drop_table("notification_email_outbox")
    op.drop_table("user_avatars")
    op.drop_index("ix_users_username_key", table_name="users")
    op.drop_column("users", "email_job_results")
    op.drop_column("users", "email_critical_announcements")
    op.drop_column("users", "email_verified_at")
    op.drop_column("users", "username_key")
    op.drop_column("users", "username")
