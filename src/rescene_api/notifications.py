"""Notification scope, subscription rules and batch outbox helpers."""

from __future__ import annotations

from sqlalchemy import ColumnElement, and_, case, func, insert, literal, or_, select
from sqlalchemy.orm import InstrumentedAttribute, Session

from rescene_api.models import (
    Announcement,
    Notification,
    NotificationEmailOutbox,
    Project,
    ProjectMember,
    User,
    new_id,
    now,
)


def _notification_project_scope(user_id: str | InstrumentedAttribute[str], is_admin: ColumnElement[bool]):
    membership = (
        select(ProjectMember.project_id)
        .where(ProjectMember.project_id == Project.id, ProjectMember.user_id == user_id)
        .correlate(Project, User)
        .exists()
    )
    project = (
        select(Project.id)
        .where(
            Project.id == Notification.project_id,
            Project.deleted_at.is_(None),
            or_(is_admin, Project.owner_id == user_id, membership),
        )
        .correlate(Notification, User)
        .exists()
    )
    return or_(Notification.project_id.is_(None), project)


def notification_scope(user: User):
    """Use the same live project permissions for lists, counts, reads and email."""
    return and_(Notification.user_id == user.id, _notification_project_scope(user.id, literal(user.is_admin)))


def subscription_enabled(user: User, kind: str, announcement_level: str | None = None) -> bool:
    """Return whether *user* should receive an email for *kind* right now.

    Requires an active account with a verified email address. The two opt-in
    switches are independent: important announcements only, and job results only.
    """
    if not user.active or user.email_verified_at is None:
        return False
    if kind == "announcement":
        return announcement_level == "critical" and user.email_critical_announcements
    if kind in ("job.succeeded", "job.failed"):
        return user.email_job_results
    return False


def notify(
    db: Session,
    recipients: set[str | None],
    *,
    kind: str,
    title: str,
    body: str,
    project_id: str | None = None,
    job_id: str | None = None,
) -> None:
    """Queue one notification per distinct recipient; anonymous actors are skipped.

    Station notifications are inserted for every non-null recipient, preserving
    the existing behaviour. Outbox rows are only added for active, verified,
    opted-in accounts.
    """
    created_at = now()
    ids = {user_id: new_id() for user_id in recipients if user_id}
    if not ids:
        return
    db.execute(
        insert(Notification),
        [
            {
                "id": notification_id,
                "user_id": user_id,
                "kind": kind,
                "title": title,
                "body": body,
                "project_id": project_id,
                "job_id": job_id,
                "created_at": created_at,
            }
            for user_id, notification_id in ids.items()
        ],
    )
    if kind not in {"job.succeeded", "job.failed"}:
        return
    eligible = (
        select(Notification.id, literal("pending"), Notification.created_at)
        .join(User, User.id == Notification.user_id)
        .where(
            Notification.id.in_(ids.values()),
            User.active.is_(True),
            User.email_verified_at.is_not(None),
            User.email_job_results.is_(True),
            _notification_project_scope(User.id, User.is_admin.is_(True)),
        )
    )
    db.execute(insert(NotificationEmailOutbox).from_select(("notification_id", "state", "next_attempt_at"), eligible))


def publish_announcement_notifications(db: Session, row: Announcement) -> tuple[int, int]:
    """Fan out one station notification per active account for *row*.

    Also inserts outbox rows in the same transaction for active, verified users
    who subscribe to important announcements when *row* is critical. Returns
    ``(recipient_count, pending_count)``.
    """
    users = db.execute(
        select(User.id, User.active, User.email_verified_at, User.email_critical_announcements)
        .where(User.active.is_(True))
        .execution_options(yield_per=500)
    )
    created_at = now()
    recipients = pending = 0
    for batch in users.partitions(500):
        notifications = []
        outbox = []
        for user in batch:
            notification_id = new_id()
            notifications.append(
                {
                    "id": notification_id,
                    "user_id": user.id,
                    "kind": "announcement",
                    "title": row.title,
                    "body": row.body,
                    "announcement_id": row.id,
                    "created_at": created_at,
                }
            )
            if subscription_enabled(user, "announcement", row.level):
                outbox.append({"notification_id": notification_id, "state": "pending", "next_attempt_at": created_at})
        db.execute(insert(Notification), notifications)
        if outbox:
            db.execute(insert(NotificationEmailOutbox), outbox)
        recipients += len(notifications)
        pending += len(outbox)
    return recipients, pending


_PENDING_STATES = ("pending", "leased", "sending")


def announcement_counts(db: Session, ids: list[str]) -> dict[str, dict[str, int]]:
    """Return per-announcement delivery statistics for the requested ids.

    The six counters are ``recipient_count``, ``read_count``, ``mail_pending``,
    ``mail_accepted``, ``mail_failed`` and ``mail_unknown``. ``mail_pending``
    aggregates ``pending``, ``leased`` and ``sending`` states; ``skipped`` is
    excluded. Announcements without notification rows are absent.
    """
    if not ids:
        return {}
    counts = {}

    outbox = NotificationEmailOutbox
    stmt = (
        select(
            Notification.announcement_id,
            func.count(Notification.id).label("recipient_count"),
            func.count(Notification.read_at).label("read_count"),
            func.sum(case((outbox.state.in_(_PENDING_STATES), 1), else_=0)).label("mail_pending"),
            func.sum(case((outbox.state == "accepted", 1), else_=0)).label("mail_accepted"),
            func.sum(case((outbox.state == "failed", 1), else_=0)).label("mail_failed"),
            func.sum(case((outbox.state == "unknown", 1), else_=0)).label("mail_unknown"),
        )
        .outerjoin(outbox, outbox.notification_id == Notification.id)
        .where(Notification.announcement_id.in_(ids))
        .group_by(Notification.announcement_id)
    )

    for row in db.execute(stmt).mappings():
        id_ = row.announcement_id
        counts[id_] = {
            "recipient_count": int(row.recipient_count or 0),
            "read_count": int(row.read_count or 0),
            "mail_pending": int(row.mail_pending or 0),
            "mail_accepted": int(row.mail_accepted or 0),
            "mail_failed": int(row.mail_failed or 0),
            "mail_unknown": int(row.mail_unknown or 0),
        }

    return counts
