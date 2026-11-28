"""Reliable at-least-once delivery of notification emails.

The outbox stores one row per notification that should be emailed.  A single
background coroutine claims small batches with short leases, re-validates the
recipient, delivers through SMTP, and records the terminal outcome.

State machine:

- ``pending``   waiting to be processed
- ``leased``    claimed by a worker; building/validating before SMTP
- ``sending``   SMTP transaction in progress
- ``accepted``  terminal: 250/251 after DATA
- ``failed``    terminal: permanent refusal, exhausted retries, or no SMTP config
- ``unknown``   terminal: connection lost after DATA started, or abandoned in
                ``sending``
- ``skipped``   terminal: recipient no longer eligible or unsupported kind

No email addresses, SMTP responses, or message bodies are logged.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Callable
from contextlib import contextmanager, suppress
from datetime import timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from rescene_api.config import settings
from rescene_api.email import SmtpResult, send_notification_email
from rescene_api.models import Announcement, Notification, NotificationEmailOutbox, User, now
from rescene_api.notifications import notification_scope, subscription_enabled

logger = logging.getLogger(__name__)

BATCH_SIZE = 20
LEASE_SECONDS = 60
IDLE_SECONDS = 5
MAX_ATTEMPTS = 3

# Retry schedule for transient failures.  ``attempts`` is incremented when a
# row enters ``sending``, so after the first failed SMTP attempt we wait 1
# minute, after the second we wait 5 minutes, and after the third we give up.
_RETRY_DELTAS = {
    1: timedelta(minutes=1),
    2: timedelta(minutes=5),
}

# Stable error codes surfaced in logs and stored in ``error_code``.
# Tests may assert on these exact strings.
ERROR_SKIPPED_INELIGIBLE = "skipped_ineligible"
ERROR_SKIPPED_UNSUPPORTED = "skipped_unsupported_kind"
ERROR_SMTP_NOT_CONFIGURED = "smtp_not_configured"
ERROR_MAX_ATTEMPTS = "max_attempts_exceeded"
ERROR_UNKNOWN = "smtp_unknown"
ERROR_ABANDONED_SENDING = "smtp_abandoned_sending"


@contextmanager
def _session(sessions: Callable[[], Session]):
    """Open and close one ORM session for a synchronous drain."""
    db = sessions()
    try:
        yield db
    finally:
        db.close()


def _lease_id() -> str:
    return secrets.token_hex(16)


def _claim_batch(db: Session, limit: int) -> list[NotificationEmailOutbox]:
    """Find rows that are due and not currently leased by another worker."""
    return list(
        db.scalars(
            select(NotificationEmailOutbox)
            .where(
                NotificationEmailOutbox.state.in_(["pending", "leased", "sending"]),
                or_(
                    NotificationEmailOutbox.lease_until.is_(None),
                    NotificationEmailOutbox.lease_until < now(),
                ),
                NotificationEmailOutbox.next_attempt_at <= now(),
            )
            .order_by(NotificationEmailOutbox.next_attempt_at)
            .limit(limit)
        ).all()
    )


def _acquire_lease(db: Session, record: NotificationEmailOutbox) -> str | None:
    """Claim a ``pending`` or expired ``leased`` row; set it to ``leased``.

    Does not increment ``attempts``; that happens only when entering SMTP.
    """
    lease_id = _lease_id()
    lease_until = now() + timedelta(seconds=LEASE_SECONDS)
    result = db.execute(
        update(NotificationEmailOutbox)
        .where(
            NotificationEmailOutbox.notification_id == record.notification_id,
            NotificationEmailOutbox.state.in_(["pending", "leased"]),
            or_(
                NotificationEmailOutbox.lease_until.is_(None),
                NotificationEmailOutbox.lease_until < now(),
            ),
            NotificationEmailOutbox.next_attempt_at <= now(),
        )
        .values(
            state="leased",
            lease_id=lease_id,
            lease_until=lease_until,
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    if result.rowcount != 1:
        return None
    return lease_id


def _abandon_sending(db: Session, record: NotificationEmailOutbox) -> bool:
    """CAS mark an expired ``sending`` row as ``unknown`` without retrying.

    A row reaches this state when a previous worker committed ``sending`` but
    did not record a terminal outcome before its lease expired.  We cannot know
    whether SMTP accepted the message, so we do not retry.
    """
    result = db.execute(
        update(NotificationEmailOutbox)
        .where(
            NotificationEmailOutbox.notification_id == record.notification_id,
            NotificationEmailOutbox.state == "sending",
            NotificationEmailOutbox.lease_id == record.lease_id,
            NotificationEmailOutbox.lease_until < now(),
        )
        .values(
            state="unknown",
            error_code=ERROR_ABANDONED_SENDING,
            lease_id=None,
            lease_until=None,
            next_attempt_at=now(),
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    if result.rowcount == 1:
        logger.info("Outbox record %s marked unknown: abandoned in sending", record.notification_id)
        return True
    return False


def _enter_sending(db: Session, notification_id: str, lease_id: str) -> int | None:
    """CAS move a ``leased`` row to ``sending`` and increment attempts.

    This is the last DB write before SMTP; it must succeed while the lease is
    still valid.  Attempts are counted only here, just before the actual send.
    """
    result = db.execute(
        update(NotificationEmailOutbox)
        .where(
            NotificationEmailOutbox.notification_id == notification_id,
            NotificationEmailOutbox.state == "leased",
            NotificationEmailOutbox.lease_id == lease_id,
            NotificationEmailOutbox.lease_until > now(),
        )
        .values(
            state="sending",
            attempts=NotificationEmailOutbox.attempts + 1,
            lease_until=now() + timedelta(seconds=LEASE_SECONDS),
        )
        .returning(NotificationEmailOutbox.attempts)
        .execution_options(synchronize_session=False)
    )
    attempts = result.scalar_one_or_none()
    db.commit()
    return attempts


def _skip_leased(db: Session, notification_id: str, lease_id: str, error_code: str) -> bool:
    """CAS mark a ``leased`` row as ``skipped``."""
    result = db.execute(
        update(NotificationEmailOutbox)
        .where(
            NotificationEmailOutbox.notification_id == notification_id,
            NotificationEmailOutbox.state == "leased",
            NotificationEmailOutbox.lease_id == lease_id,
        )
        .values(
            state="skipped",
            error_code=error_code,
            lease_id=None,
            lease_until=None,
            next_attempt_at=now(),
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return result.rowcount == 1


def _schedule_retry(db: Session, notification_id: str, lease_id: str, attempts: int, error_code: str | None) -> bool:
    """CAS move a ``sending`` row back to ``pending`` with the next retry time."""
    delta = _RETRY_DELTAS[attempts]
    result = db.execute(
        update(NotificationEmailOutbox)
        .where(
            NotificationEmailOutbox.notification_id == notification_id,
            NotificationEmailOutbox.lease_id == lease_id,
            NotificationEmailOutbox.state == "sending",
        )
        .values(
            state="pending",
            error_code=error_code,
            lease_id=None,
            lease_until=None,
            next_attempt_at=now() + delta,
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return result.rowcount == 1


def _set_terminal(
    db: Session,
    notification_id: str,
    lease_id: str,
    state: str,
    error_code: str | None,
) -> bool:
    """CAS update from ``sending`` to a terminal state."""
    result = db.execute(
        update(NotificationEmailOutbox)
        .where(
            NotificationEmailOutbox.notification_id == notification_id,
            NotificationEmailOutbox.lease_id == lease_id,
            NotificationEmailOutbox.state == "sending",
        )
        .values(
            state=state,
            error_code=error_code,
            lease_id=None,
            lease_until=None,
            next_attempt_at=now(),
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return result.rowcount == 1


def _apply_smtp_result(
    db: Session,
    notification_id: str,
    lease_id: str,
    result: SmtpResult,
    attempts: int,
) -> bool:
    """Record the outcome of one SMTP attempt."""
    if result.state == "accepted":
        applied = _set_terminal(db, notification_id, lease_id, "accepted", None)
        if applied:
            logger.info("Outbox record %s accepted", notification_id)
        return applied

    if result.state == "not_configured":
        applied = _set_terminal(db, notification_id, lease_id, "failed", ERROR_SMTP_NOT_CONFIGURED)
        if applied:
            logger.warning("Outbox record %s failed: %s", notification_id, ERROR_SMTP_NOT_CONFIGURED)
        return applied

    if result.state == "transient":
        if attempts < MAX_ATTEMPTS:
            applied = _schedule_retry(db, notification_id, lease_id, attempts, result.error_code)
            if applied:
                logger.info("Outbox record %s retry scheduled: %s", notification_id, result.error_code)
            return applied
        applied = _set_terminal(db, notification_id, lease_id, "failed", result.error_code or ERROR_MAX_ATTEMPTS)
        if applied:
            logger.warning("Outbox record %s failed: %s", notification_id, result.error_code or ERROR_MAX_ATTEMPTS)
        return applied

    if result.state == "permanent":
        applied = _set_terminal(db, notification_id, lease_id, "failed", result.error_code or ERROR_UNKNOWN)
        if applied:
            logger.warning(
                "Outbox record %s permanent failure: %s",
                notification_id,
                result.error_code or ERROR_UNKNOWN,
            )
        return applied

    # result.state == "unknown": the server may or may not have accepted the
    # message after DATA started.  Do not retry, to avoid duplicate sends.
    applied = _set_terminal(db, notification_id, lease_id, "unknown", result.error_code or ERROR_UNKNOWN)
    if applied:
        logger.warning(
            "Outbox record %s delivery uncertain: %s",
            notification_id,
            result.error_code or ERROR_UNKNOWN,
        )
    return applied


def _announcement_level(db: Session, announcement_id: str | None) -> str | None:
    if not announcement_id:
        return None
    row = db.get(Announcement, announcement_id)
    return row.level if row else None


def _build_email(notification: Notification) -> tuple[str, str] | None:
    """Return (subject, body) for a notification, or None if it should not be emailed."""
    optout_hint = "如需更改邮件订阅，请登录 ReScene 后前往设置 → 通知偏好。"
    if notification.kind == "announcement":
        # Only critical announcements are emailed; non-critical rows should not
        # reach the outbox, but we defensively skip them here.
        return (
            f"ReScene 重要公告：{notification.title}",
            "\n".join(
                (
                    notification.title,
                    "",
                    notification.body or "",
                    "",
                    optout_hint,
                )
            ),
        )
    if notification.kind == "job.succeeded":
        return (
            "ReScene 任务成功",
            f"你有一个重建任务已成功完成，请前往工作台查看详情。\n\n{optout_hint}",
        )
    if notification.kind == "job.failed":
        return (
            "ReScene 任务失败",
            f"你有一个重建任务已失败，请前往工作台查看详情。\n\n{optout_hint}",
        )
    return None


def _still_eligible(db: Session, user: User, notification: Notification) -> bool:
    """Re-validate recipient before SMTP.  Mirrors enqueue-time checks."""
    level = _announcement_level(db, notification.announcement_id)
    if not subscription_enabled(user, notification.kind, level):
        return False
    # Confirm the notification is still visible to the user (project access
    # may have been revoked, or an announcement may have been retracted).
    visible = (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.id == notification.id, notification_scope(user))
        )
        or 0
    )
    return visible > 0


def _process_one(db: Session, record: NotificationEmailOutbox) -> bool:
    """Process one outbox record.  Return True if the row was terminalised."""
    if record.state == "sending":
        # A previous worker committed ``sending`` but did not finish.  We do
        # not retry because the message may already have been accepted.
        return _abandon_sending(db, record)

    lease_id = _acquire_lease(db, record)
    if lease_id is None:
        return False

    notification_id = record.notification_id

    notification = db.get(Notification, notification_id)
    if notification is None:
        return _skip_leased(db, notification_id, lease_id, ERROR_SKIPPED_INELIGIBLE)

    user = db.get(User, notification.user_id)
    if user is None or not _still_eligible(db, user, notification):
        logger.info("Outbox record %s skipped: recipient no longer eligible", notification_id)
        return _skip_leased(db, notification_id, lease_id, ERROR_SKIPPED_INELIGIBLE)

    email_parts = _build_email(notification)
    if email_parts is None:
        logger.info("Outbox record %s skipped: unsupported kind %s", notification_id, notification.kind)
        return _skip_leased(db, notification_id, lease_id, ERROR_SKIPPED_UNSUPPORTED)

    subject, body = email_parts
    user_email = user.email

    # Last DB write before SMTP: move to ``sending`` and increment attempts.
    attempts = _enter_sending(db, notification_id, lease_id)
    if attempts is None:
        return False

    # SMTP happens with scalar values only; no ORM objects are touched and no
    # DB transaction is held open during network I/O.
    result = send_notification_email(user_email, subject, body, config=settings())

    return _apply_smtp_result(db, notification_id, lease_id, result, attempts)


def drain_outbox(sessions: Callable[[], Session]) -> int:
    """Process one batch of outbox records synchronously.

    Returns the number of rows whose state was successfully advanced.
    """
    processed = 0
    with _session(sessions) as db:
        records = _claim_batch(db, BATCH_SIZE)
        if not records:
            return 0
        for record in records:
            try:
                if _process_one(db, record):
                    processed += 1
            except Exception:
                # Do not use logger.exception: exception objects may carry raw
                # SMTP responses or addresses.  The lease will expire and the
                # row will be reclaimed or marked unknown by a later drain.
                logger.error("Outbox record %s processing failed", record.notification_id)
                with suppress(Exception):
                    db.rollback()
    return processed


async def run_outbox(sessions: Callable[[], Session]) -> None:
    """Long-running outbox consumer.  The caller is responsible for cancellation."""
    await asyncio.sleep(IDLE_SECONDS)
    while True:
        try:
            processed = await asyncio.to_thread(drain_outbox, sessions)
        except Exception:
            logger.error("Outbox drain failed")
            processed = 0
        if processed == 0:
            await asyncio.sleep(IDLE_SECONDS)
