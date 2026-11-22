"""Outbound SMTP delivery for one-time email codes.

Sending happens in a background task, so every failure is logged and swallowed:
the anonymous caller must always see the same generic status, whether or not the
address exists and whether or not the mail server accepted the message.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from rescene_api.config import Settings, settings

logger = logging.getLogger(__name__)

SUBJECTS = {
    "login": "ReScene 登录验证码",
    "reset": "ReScene 密码重置验证码",
}

PURPOSE_HINTS = {
    "login": "在登录页输入该验证码即可登录。",
    "reset": "在忘记密码页输入该验证码并设置新密码。",
}

SECURITY_MODES = {"starttls", "ssl", "none"}


class EmailNotConfigured(RuntimeError):
    """SMTP settings are missing; the code was generated but cannot be sent."""


def build_code_message(recipient: str, code: str, purpose: str, config: Settings) -> EmailMessage:
    """Compose the plain-text notification; the code is the only actionable part."""
    sender = config.smtp_from or config.smtp_username or ""
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
    if not config.smtp_host or not (config.smtp_from or config.smtp_username):
        raise EmailNotConfigured("RESCENE_SMTP_HOST and RESCENE_SMTP_FROM are required")
    if config.smtp_security not in SECURITY_MODES:
        raise RuntimeError(f"Unsupported RESCENE_SMTP_SECURITY {config.smtp_security!r}")
    message = build_code_message(recipient, code, purpose, config)
    sender = config.smtp_from or config.smtp_username or ""
    context = ssl.create_default_context()
    if config.smtp_security == "ssl":
        client: smtplib.SMTP = smtplib.SMTP_SSL(
            config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds, context=context
        )
    else:
        client = smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds)
    with client:
        if config.smtp_security == "starttls":
            client.starttls(context=context)
        if config.smtp_username and config.smtp_password:
            client.login(config.smtp_username, config.smtp_password)
        client.send_message(message, from_addr=sender, to_addrs=[recipient])


def deliver_email_code(recipient: str, code: str, purpose: str) -> None:
    """Background entry point: never raises, so the 202 response always stands."""
    try:
        send_email_code(recipient, code, purpose)
    except EmailNotConfigured:
        config = settings()
        if config.environment == "production":
            logger.error("SMTP is not configured; %s code for %s was discarded", purpose, recipient)
        else:
            logger.warning(
                "SMTP is not configured; %s code for %s is %s (%s-minute TTL, development log only)",
                purpose,
                recipient,
                code,
                config.email_code_ttl_minutes,
            )
    except Exception:
        logger.exception("Failed to send %s code to %s", purpose, recipient)
