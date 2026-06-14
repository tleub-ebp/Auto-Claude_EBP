"""Transactional email (invitation links) over SMTP.

Uses the stdlib :mod:`smtplib` (no async SMTP dependency available) run in a
worker thread so it never blocks the event loop. TLS is mandatory: either
implicit TLS (``smtp_use_ssl``, port 465) or STARTTLS (``smtp_use_tls``,
port 587). If SMTP is not configured the caller is expected to fall back to
returning the invite link for manual delivery.

Security: the invitation token is part of ``invite_link`` and is therefore
never logged here — only the recipient address and a success/failure flag.
"""

from __future__ import annotations

import asyncio
import html
import logging
import smtplib
import ssl
from email.message import EmailMessage

from server.config import ServerSettings, get_settings

logger = logging.getLogger(__name__)

_SMTP_TIMEOUT_SECONDS = 15


class EmailError(Exception):
    """SMTP send failed."""


def _build_invitation_message(
    settings: ServerSettings,
    to_email: str,
    invite_link: str,
    inviter_name: str | None,
    role: str,
) -> EmailMessage:
    inviter = inviter_name or "WorkPilot"
    safe_link = html.escape(invite_link, quote=True)
    msg = EmailMessage()
    msg["Subject"] = "Votre invitation WorkPilot AI"
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    text = (
        f"{inviter} vous invite à rejoindre WorkPilot AI (rôle : {role}).\n\n"
        f"Pour créer votre compte et définir votre mot de passe, ouvrez ce lien :\n"
        f"{invite_link}\n\n"
        f"Ce lien est à usage unique et expire prochainement.\n"
        f"Si vous n'attendiez pas cette invitation, ignorez ce message.\n"
    )
    msg.set_content(text)
    msg.add_alternative(
        f"""\
<html><body style="font-family:sans-serif;line-height:1.5">
  <h2>WorkPilot AI</h2>
  <p>{html.escape(inviter)} vous invite à rejoindre WorkPilot AI
     (rôle&nbsp;: <strong>{html.escape(role)}</strong>).</p>
  <p><a href="{safe_link}"
        style="display:inline-block;padding:10px 16px;background:#2563eb;
               color:#fff;text-decoration:none;border-radius:6px">
     Créer mon compte</a></p>
  <p style="color:#666;font-size:13px">Ce lien est à usage unique et expire
     prochainement. Si vous n'attendiez pas cette invitation, ignorez ce
     message.</p>
</body></html>
""",
        subtype="html",
    )
    return msg


def _send_sync(settings: ServerSettings, msg: EmailMessage) -> None:
    context = ssl.create_default_context()
    if settings.smtp_use_ssl:
        smtp: smtplib.SMTP = smtplib.SMTP_SSL(
            settings.smtp_host,
            settings.smtp_port,
            timeout=_SMTP_TIMEOUT_SECONDS,
            context=context,
        )
    else:
        smtp = smtplib.SMTP(
            settings.smtp_host, settings.smtp_port, timeout=_SMTP_TIMEOUT_SECONDS
        )
    try:
        smtp.ehlo()
        if settings.smtp_use_tls and not settings.smtp_use_ssl:
            smtp.starttls(context=context)
            smtp.ehlo()
        if settings.smtp_user:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(msg)
    finally:
        try:
            smtp.quit()
        except Exception:  # noqa: BLE001 — best-effort close
            pass


async def send_invitation_email(
    to_email: str,
    invite_link: str,
    inviter_name: str | None,
    role: str,
) -> None:
    """Send an invitation email. Raises :class:`EmailError` on failure."""
    settings = get_settings()
    if not settings.email_enabled:
        raise EmailError("SMTP is not configured")
    msg = _build_invitation_message(settings, to_email, invite_link, inviter_name, role)
    try:
        await asyncio.to_thread(_send_sync, settings, msg)
    except Exception as exc:  # noqa: BLE001 — normalize to EmailError
        # Never include the message body / link in the log.
        logger.warning("[Email] invitation to %s failed: %s", to_email, exc)
        raise EmailError(str(exc)) from exc
    logger.info("[Email] invitation sent to %s", to_email)
