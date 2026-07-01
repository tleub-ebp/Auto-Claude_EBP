"""Multi-channel notification service — per-channel payload builders + delivery.

Each builder turns a :class:`PRReadyNotification` into the native rich-message
format of its channel:

- Microsoft Teams → Adaptive Card (Incoming Webhook / Workflows)
- Slack          → Block Kit (Incoming Webhook)
- Discord        → Embed (channel webhook)
- Google Chat    → cardsV2 (space webhook)
- Generic        → flat JSON payload (any HTTP endpoint)
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

from .models import ChannelResult, NotificationChannel, PRReadyNotification

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT_SECONDS = 10


def _get_app_language() -> str:
    """Get the current app language from environment variable set by the frontend."""
    return os.environ.get("APP_LANGUAGE", "en")


# ── i18n strings shared by all channels ────────────────────────────────────
_STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "pr_ready_title": "✅ Task completed — PR ready for review",
        "pr_ready_body": "The task has been completed and a PR has been created for human review.",
        "task_label": "Task",
        "description_label": "Description",
        "project_label": "Project",
        "branch_label": "Branch",
        "target_label": "Target branch",
        "pr_label": "Pull Request",
        "review_prompt": "Click below to review the changes.",
        "review_button": "Open PR",
        "footer": "WorkPilot AI",
    },
    "fr": {
        "pr_ready_title": "✅ Tâche terminée — PR prête pour revue",
        "pr_ready_body": "La tâche est terminée et une PR a été créée pour validation humaine.",
        "task_label": "Tâche",
        "description_label": "Description",
        "project_label": "Projet",
        "branch_label": "Branche",
        "target_label": "Branche cible",
        "pr_label": "Pull Request",
        "review_prompt": "Cliquez ci-dessous pour examiner les changements.",
        "review_button": "Ouvrir la PR",
        "footer": "WorkPilot AI",
    },
}


def _strings() -> dict[str, str]:
    return _STRINGS.get(_get_app_language(), _STRINGS["en"])


def _facts(notif: PRReadyNotification, s: dict[str, str]) -> list[tuple[str, str]]:
    """Build the (label, value) pairs shared by all channel layouts."""
    facts: list[tuple[str, str]] = []
    if notif.project_name:
        facts.append((s["project_label"], notif.project_name))
    if notif.branch:
        facts.append((s["branch_label"], notif.branch))
    if notif.target_branch:
        facts.append((s["target_label"], notif.target_branch))
    return facts


# ── Payload builders ────────────────────────────────────────────────────────


def build_teams_payload(notif: PRReadyNotification) -> dict:
    """Adaptive Card for Microsoft Teams (Incoming Webhook / Workflows)."""
    s = _strings()

    body: list[dict] = [
        {
            "type": "TextBlock",
            "text": s["pr_ready_title"],
            "weight": "bolder",
            "size": "large",
        },
        {
            "type": "TextBlock",
            "text": notif.task_title,
            "weight": "bolder",
            "wrap": True,
        },
        {
            "type": "TextBlock",
            "text": s["pr_ready_body"],
            "wrap": True,
            "spacing": "small",
        },
    ]
    if notif.task_description:
        body.append(
            {
                "type": "TextBlock",
                "text": notif.task_description,
                "wrap": True,
                "isSubtle": True,
                "spacing": "small",
            }
        )

    facts = _facts(notif, s)
    if facts:
        body.append(
            {
                "type": "FactSet",
                "facts": [{"title": label, "value": value} for label, value in facts],
                "spacing": "medium",
            }
        )

    actions: list[dict] = []
    if notif.pr_url:
        body.append(
            {
                "type": "TextBlock",
                "text": s["review_prompt"],
                "wrap": True,
                "spacing": "small",
            }
        )
        actions.append(
            {
                "type": "Action.OpenUrl",
                "title": s["review_button"],
                "url": notif.pr_url,
            }
        )

    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": body,
                    "actions": actions,
                    "msteams": {"width": "Full"},
                },
            }
        ],
    }


def build_slack_payload(notif: PRReadyNotification) -> dict:
    """Block Kit message for a Slack Incoming Webhook."""
    s = _strings()

    blocks: list[dict] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": s["pr_ready_title"], "emoji": True},
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*{notif.task_title}*\n{s['pr_ready_body']}",
            },
        },
    ]
    if notif.task_description:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"_{notif.task_description}_"},
            }
        )

    facts = _facts(notif, s)
    if facts:
        blocks.append(
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*{label}:*\n{value}"}
                    for label, value in facts
                ],
            }
        )

    if notif.pr_url:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": s["review_button"],
                            "emoji": True,
                        },
                        "url": notif.pr_url,
                        "style": "primary",
                    }
                ],
            }
        )

    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": s["footer"]}],
        }
    )

    # `text` is the accessibility / notification fallback
    fallback = f"{s['pr_ready_title']} — {notif.task_title}"
    if notif.pr_url:
        fallback += f" — {notif.pr_url}"
    return {"text": fallback, "blocks": blocks}


def build_discord_payload(notif: PRReadyNotification) -> dict:
    """Embed message for a Discord channel webhook."""
    s = _strings()

    embed: dict = {
        "title": notif.task_title[:256],
        "description": s["pr_ready_body"],
        "color": 0x2ECC71,  # green
        "footer": {"text": s["footer"]},
        "fields": [
            {"name": label, "value": value, "inline": True}
            for label, value in _facts(notif, s)
        ],
    }
    if notif.pr_url:
        embed["url"] = notif.pr_url
        embed["fields"].append(
            {"name": s["pr_label"], "value": notif.pr_url, "inline": False}
        )
    if notif.task_description:
        embed["description"] = f"{s['pr_ready_body']}\n\n{notif.task_description}"[
            :4096
        ]

    return {"content": s["pr_ready_title"], "embeds": [embed]}


def build_google_chat_payload(notif: PRReadyNotification) -> dict:
    """cardsV2 message for a Google Chat space webhook."""
    s = _strings()

    widgets: list[dict] = [
        {
            "decoratedText": {
                "topLabel": s["task_label"],
                "text": notif.task_title,
                "wrapText": True,
            }
        }
    ]
    if notif.task_description:
        widgets.append(
            {
                "decoratedText": {
                    "topLabel": s["description_label"],
                    "text": notif.task_description,
                    "wrapText": True,
                }
            }
        )
    for label, value in _facts(notif, s):
        widgets.append({"decoratedText": {"topLabel": label, "text": value}})

    if notif.pr_url:
        widgets.append(
            {
                "buttonList": {
                    "buttons": [
                        {
                            "text": s["review_button"],
                            "onClick": {"openLink": {"url": notif.pr_url}},
                        }
                    ]
                }
            }
        )

    return {
        "text": f"{s['pr_ready_title']} — {notif.task_title}",
        "cardsV2": [
            {
                "cardId": "workpilot-pr-ready",
                "card": {
                    "header": {
                        "title": s["pr_ready_title"],
                        "subtitle": s["footer"],
                    },
                    "sections": [{"widgets": widgets}],
                },
            }
        ],
    }


def build_generic_payload(notif: PRReadyNotification) -> dict:
    """Flat JSON payload for any custom HTTP endpoint."""
    return notif.to_event_data()


_PAYLOAD_BUILDERS = {
    NotificationChannel.TEAMS: build_teams_payload,
    NotificationChannel.SLACK: build_slack_payload,
    NotificationChannel.DISCORD: build_discord_payload,
    NotificationChannel.GOOGLE_CHAT: build_google_chat_payload,
    NotificationChannel.WEBHOOK: build_generic_payload,
}


def build_payload(channel: NotificationChannel, notif: PRReadyNotification) -> dict:
    """Build the native payload for the given channel."""
    return _PAYLOAD_BUILDERS[channel](notif)


def build_text_payload(channel: NotificationChannel, message: str) -> dict:
    """Wrap a plain-text message into the channel's native format."""
    if channel == NotificationChannel.SLACK:
        return {"text": message}
    if channel == NotificationChannel.DISCORD:
        return {"content": message[:2000]}
    if channel == NotificationChannel.GOOGLE_CHAT:
        return {"text": message}
    if channel == NotificationChannel.WEBHOOK:
        return {"event": "test", "message": message}
    # Teams: minimal Adaptive Card
    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": [{"type": "TextBlock", "text": message, "wrap": True}],
                },
            }
        ],
    }


# ── Delivery ────────────────────────────────────────────────────────────────


def validate_webhook_url(url: str) -> None:
    """SSRF guard for outbound webhook delivery.

    Reject any URL whose host resolves to a private, loopback, link-local,
    multicast, reserved or unspecified address — closing the path to internal
    services and cloud metadata (e.g. 169.254.169.254). Every A/AAAA record is
    resolved so an attacker cannot hide a private IP behind a multi-record DNS
    response. Only http/https URLs are accepted.

    Raises:
        ValueError: if the URL is malformed, non-http(s), unresolvable, or
            resolves to a non-routable address.
    """
    if not url:
        raise ValueError("Webhook URL cannot be empty")
    try:
        parsed = urlparse(url)
    except Exception as exc:  # noqa: BLE001 — any parse error is a rejection
        raise ValueError(f"Invalid webhook URL: {exc}")
    if parsed.scheme not in ("https", "http"):
        raise ValueError("Only HTTP and HTTPS webhook URLs are allowed")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Webhook URL has no host")

    try:
        infos = socket.getaddrinfo(
            hostname, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
        )
    except socket.gaierror:
        raise ValueError(f"Unable to resolve webhook host: {hostname}")
    if not infos:
        raise ValueError(f"No addresses resolved for webhook host: {hostname}")

    for info in infos:
        family, _, _, _, sockaddr = info
        ip_str = sockaddr[0]
        try:
            raw = ip_str.split("%", 1)[0] if family == socket.AF_INET6 else ip_str
            ip_obj = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise ValueError(f"Invalid resolved address {ip_str!r}: {exc}")
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        ):
            raise ValueError(
                f"Webhook host {hostname} resolves to a non-routable / private "
                f"address ({ip_str}) and is not allowed"
            )


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject HTTP redirects on webhook delivery.

    The upfront SSRF guard only validates the *initial* host. Following a 3xx
    would let a malicious endpoint bounce the request to an internal address
    (e.g. 169.254.169.254) that was never validated, so we refuse to redirect
    at all (CodeQL py/full-ssrf).
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        raise urllib.error.HTTPError(
            req.full_url, code, f"Redirects are not allowed ({msg})", headers, fp
        )


# Opener with redirects disabled; reused for every webhook POST.
_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def post_json(url: str, payload: dict) -> tuple[bool, int | None, str | None]:
    """POST a JSON payload. Returns (success, status_code, error).

    The destination is validated against SSRF (:func:`validate_webhook_url`)
    before any request is made, so a blocked URL never reaches the network and
    leaks no reachability oracle beyond the rejection reason. Redirects are
    refused so a validated host cannot bounce the request to an internal one.
    """
    try:
        validate_webhook_url(url)
        parsed = urlparse(url)
        safe_url = parsed._replace().geturl()
    except ValueError as exc:
        logger.warning("[Notifications] blocked webhook URL: %s", exc)
        return False, None, str(exc)
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            safe_url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with _NO_REDIRECT_OPENER.open(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
            ok = 200 <= resp.status < 300
            return ok, resp.status, None if ok else f"HTTP {resp.status}"
    except urllib.error.HTTPError as exc:
        return False, exc.code, f"HTTP {exc.code}: {exc.reason}"
    except urllib.error.URLError as exc:
        return False, None, f"URL error: {exc.reason}"
    except Exception as exc:  # noqa: BLE001 — notifications must never crash callers
        return False, None, str(exc)


def send_to_channel(
    channel: NotificationChannel,
    webhook_url: str,
    notif: PRReadyNotification,
) -> ChannelResult:
    """Build the channel payload and deliver it to the webhook URL."""
    payload = build_payload(channel, notif)
    success, status_code, error = post_json(webhook_url, payload)
    if success:
        logger.info("[Notifications] %s notification sent", channel.value)
    else:
        logger.warning(
            "[Notifications] %s notification failed: %s", channel.value, error
        )
    return ChannelResult(
        channel=channel, success=success, status_code=status_code, error=error
    )
