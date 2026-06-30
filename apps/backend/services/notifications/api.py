"""Multi-channel notification service — API endpoints.

Mounted in provider_api.py. Used by the project settings UI to test a
webhook URL server-side (browser fetch would be blocked by CORS on most
webhook providers).

  POST /api/notifications/test   body: {"channel": "...", "url": "https://..."}
"""

from __future__ import annotations

import os
from typing import Annotated, Any

from fastapi import APIRouter, Body

from .channels import build_text_payload, post_json, validate_webhook_url
from .models import NotificationChannel

router = APIRouter()

_TEST_MESSAGES = {
    "en": "✅ WorkPilot AI — test notification. Your channel is configured correctly!",
    "fr": "✅ WorkPilot AI — notification de test. Votre canal est bien configuré !",
}


@router.post("/api/notifications/test")
def test_notification_webhook(body: Annotated[dict[str, Any], Body(...)]):
    """Send a test message to the given webhook URL."""
    try:
        channel = NotificationChannel(str(body.get("channel", "webhook")))
    except ValueError:
        return {"success": False, "error": f"Unknown channel: {body.get('channel')}"}

    url = str(body.get("url", "")).strip()
    try:
        validate_webhook_url(url)
    except ValueError as exc:
        return {"success": False, "error": str(exc)}

    lang = os.environ.get("APP_LANGUAGE", "en")
    message = _TEST_MESSAGES.get(lang, _TEST_MESSAGES["en"])
    payload = build_text_payload(channel, message)
    success, status_code, error = post_json(url, payload)
    return {"success": success, "status_code": status_code, "error": error}
