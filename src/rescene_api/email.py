"""Outbound SMTP delivery for one-time email codes and notification emails.

Sending happens in a background task for codes, so every failure is logged and
swallowed: the anonymous caller must always see the same generic status, whether
or not the address exists and whether or not the mail server accepted the
message.

No email addresses, verification codes, or raw SMTP responses are logged.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from rescene_api.config import Settings, settings

logger = logging.getLogger(__name__)

SUBJECTS = {
    "login": "ReScene 登录验证码",
    "reset": "ReScene 密码重置验证码",
    "notification_verify": "ReScene 邮箱验证",
}

PURPOSE_HINTS = {
    "login": "在登录页输入该验证码即可登录。",
    "reset": "在忘记密码页输入该验证码并设置新密码。",
    "notification_verify": "在通知设置页输入该验证码，以启用邮件订阅。",
}

SECURITY_MODES = {"starttls", "ssl", "none"}


class EmailNotConfigured(RuntimeError):
    """SMTP settings are missing; a message was queued but cannot be sent."""


@dataclass(frozen=True, slots=True)
class SmtpResult:
    """Outcome of a single SMTP delivery attempt.

    States:
    - ``accepted``: the server returned 250/251 after DATA.
    - ``transient``: a 4xx response or connect failure; safe to retry.
    - ``permanent``: a 5xx response; do not retry the same message.
    - ``unknown``: the connection was lost after DATA started; the server may
      or may not have accepted the message, so do not retry blindly.
    - ``not_configured``: SMTP is not configured.
    """

    state: str
    error_code: str | None = None


def smtp_configured(config: Settings) -> bool:
    """Return True when the minimum SMTP settings required to send are present."""
    return bool(config.smtp_host and (config.smtp_from or config.smtp_username))


def _sender(config: Settings) -> str:
    return config.smtp_from or config.smtp_username or ""


def _sanitize_subject(subject: str) -> str:
    """Remove CR/LF from a Subject header to avoid header-injection issues."""
    return subject.replace("\r", " ").replace("\n", " ").strip()


@contextmanager
def _smtp_client(config: Settings):
    """Open, authenticate, and close an SMTP client according to *config*.

    ``quit()`` failures are swallowed and the underlying socket is explicitly
    closed so that a successful DATA response can still be reported as
    ``accepted`` even if the SMTP conversation ends uncleanly.
    """
    if not smtp_configured(config):
        raise EmailNotConfigured("SMTP not configured")
    if config.smtp_security not in SECURITY_MODES:
        raise RuntimeError(f"Unsupported RESCENE_SMTP_SECURITY {config.smtp_security!r}")
    context = ssl.create_default_context()
    if config.smtp_security == "ssl":
        client: smtplib.SMTP = smtplib.SMTP_SSL(
            config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds, context=context
        )
    else:
        client = smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds)
    try:
        if config.smtp_security == "starttls":
            client.starttls(context=context)
        if config.smtp_username and config.smtp_password:
            client.login(config.smtp_username, config.smtp_password)
        yield client
    finally:
        with suppress(Exception):
            client.quit()
        with suppress(Exception):
            client.close()


def build_code_message(recipient: str, code: str, purpose: str, config: Settings) -> EmailMessage:
    """Compose the plain-text notification; the code is the only actionable part."""
    sender = _sender(config)
    message = EmailMessage()
    message["Subject"] = SUBJECTS[purpose]
    message["From"] = formataddr(("ReScene", sender))
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=sender.partition("@")[2] or None)
    message.set_content(
        "\n".join(
            (
                f"你的 ReScene 验证码是：{code}",
                "",
                f"该验证码 {config.email_code_ttl_minutes} 分钟内有效，只能使用一次。",
                PURPOSE_HINTS[purpose],
                "",
                "如果这不是你本人的操作，请忽略本邮件，并考虑尽快修改密码。",
            )
        )
    )
    return message


def send_email_code(recipient: str, code: str, purpose: str) -> None:
    """Deliver one code synchronously; raise on any transport or SMTP error."""
    config = settings()
    message = build_code_message(recipient, code, purpose, config)
    sender = _sender(config)
    with _smtp_client(config) as client:
        client.send_message(message, from_addr=sender, to_addrs=[recipient])


def deliver_email_code(recipient: str, code: str, purpose: str) -> None:
    """Background entry point: never raises, so the 202 response always stands."""
    try:
        send_email_code(recipient, code, purpose)
    except EmailNotConfigured:
        config = settings()
        # Never log recipient address or verification code.
        if config.environment == "production":
            logger.error("SMTP is not configured; %s code was discarded", purpose)
        else:
            # For login/reset purposes only, retain the historical development
            # convenience of logging the generated code.  Notification email
            # verification codes are never logged.
            if purpose in ("login", "reset"):
                logger.warning(
                    "SMTP is not configured; %s code is %s (%s-minute TTL, development log only)",
                    purpose,
                    code,
                    config.email_code_ttl_minutes,
                )
            else:
                logger.warning(
                    "SMTP is not configured; %s code is available at the API (%s-minute TTL, development log only)",
                    purpose,
                    config.email_code_ttl_minutes,
                )
    except Exception as exc:
        # Never log recipient address or verification code, and avoid
        # logger.exception which can expose raw SMTP details.
        logger.error("Failed to send %s code: %s", purpose, type(exc).__name__)


def build_plain_message(recipient: str, subject: str, body: str, config: Settings) -> EmailMessage:
    """Compose a plain-text notification email."""
    sender = _sender(config)
    message = EmailMessage()
    message["Subject"] = _sanitize_subject(subject)
    message["From"] = formataddr(("ReScene", sender))
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=sender.partition("@")[2] or None)
    message.set_content(body)
    return message


def _smtp_response_result(code: int, prefix: str) -> SmtpResult:
    """Classify an explicit SMTP response code."""
    if code >= 500:
        return SmtpResult("permanent", f"{prefix}{code}")
    if code >= 400:
        return SmtpResult("transient", f"{prefix}{code}")
    return SmtpResult("unknown", f"{prefix}{code}")


def _classify_smtp_exception(exc: Exception) -> SmtpResult:
    """Map an smtplib exception to a transient/permanent/unknown result."""
    code = None
    if isinstance(exc, (smtplib.SMTPResponseException, smtplib.SMTPSenderRefused, smtplib.SMTPDataError)):
        code = exc.smtp_code
    elif isinstance(exc, smtplib.SMTPRecipientsRefused):
        codes = {c for c, _ in exc.recipients.values() if isinstance(c, int)}
        code = next(iter(codes)) if codes else None

    if isinstance(code, int):
        return _smtp_response_result(code, "smtp_")
    return SmtpResult("unknown", "smtp_exception")


def send_notification_email(
    recipient: str,
    subject: str,
    body: str,
    config: Settings | None = None,
) -> SmtpResult:
    """Deliver one plain-text notification email and classify the outcome.

    Uses low-level MAIL/RCPT/DATA commands so that:

    - Explicit 4xx/5xx responses from MAIL, RCPT, or DATA are classified as
      transient or permanent (evidence exists, safe to act on).
    - A connection loss after the DATA body has started is ``unknown``; the
      server may have accepted the message before the TCP connection dropped.
    - A 250/251 response after DATA is ``accepted`` even if the subsequent
      QUIT fails.
    """
    config = config or settings()
    if not smtp_configured(config):
        return SmtpResult("not_configured", "smtp_not_configured")

    # Build the message inside the delivery routine so that subject sanitisation
    # and payload formatting are covered by the same exception-free path.
    message = build_plain_message(recipient, subject, body, config)
    sender = _sender(config)
    message_bytes = message.as_bytes()

    try:
        with _smtp_client(config) as client:
            client.ehlo_or_helo_if_needed()

            resp = client.mail(sender)
            if resp[0] != 250:
                return _smtp_response_result(resp[0], "smtp_mail_")

            resp = client.rcpt(recipient)
            if resp[0] not in (250, 251):
                return _smtp_response_result(resp[0], "smtp_rcpt_")

            try:
                resp = client.data(message_bytes)
            except smtplib.SMTPDataError as exc:
                # The DATA command itself was rejected (no 354); this is before
                # the message body was transmitted, so the failure is explicit.
                return _smtp_response_result(exc.smtp_code, "smtp_data_cmd_")
            except (smtplib.SMTPServerDisconnected, ConnectionError, OSError):
                # Connection lost while the DATA body was being transmitted or
                # while waiting for the final reply.  We cannot know whether
                # the server accepted the message.
                return SmtpResult("unknown", "smtp_disconnect_after_data")

            if resp[0] in (250, 251):
                return SmtpResult("accepted")
            return _smtp_response_result(resp[0], "smtp_data_")
    except smtplib.SMTPConnectError as exc:
        return SmtpResult(
            "transient",
            f"smtp_connect_{exc.smtp_code}" if exc.smtp_code else "smtp_connect",
        )
    except (smtplib.SMTPServerDisconnected, ConnectionError, OSError):
        # Connection lost before DATA started.
        return SmtpResult("unknown", "smtp_disconnect")
    except smtplib.SMTPException as exc:
        return _classify_smtp_exception(exc)
    except Exception:
        return SmtpResult("unknown", "smtp_exception")
