"""Multi-channel notification service — channel resolution + dispatch.

Channel configuration is read from environment variables (set per project in
``.workpilot/.env`` via the UI, see env-handlers.ts):

    TEAMS_NOTIFICATIONS_ENABLED=true        TEAMS_WEBHOOK_URL=...
    SLACK_NOTIFICATIONS_ENABLED=true        SLACK_WEBHOOK_URL=...
    DISCORD_NOTIFICATIONS_ENABLED=true      DISCORD_WEBHOOK_URL=...
    GOOGLE_CHAT_NOTIFICATIONS_ENABLED=true  GOOGLE_CHAT_WEBHOOK_URL=...
    NOTIFY_WEBHOOK_ENABLED=true             NOTIFY_WEBHOOK_URL=...

The PR-creation subprocess spawned by the Electron app does not always
inherit the project ``.env`` (it only gets ``process.env``), so
``NotificationService.from_env(project_path)`` also reads
``<project>/.workpilot/.env`` directly as a fallback.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from .channels import send_to_channel
from .models import (
    ChannelConfig,
    ChannelResult,
    NotificationChannel,
    PRReadyNotification,
)

logger = logging.getLogger(__name__)

# (channel, ENABLED env key, WEBHOOK URL env key)
_CHANNEL_ENV_KEYS: list[tuple[NotificationChannel, str, str]] = [
    (NotificationChannel.TEAMS, "TEAMS_NOTIFICATIONS_ENABLED", "TEAMS_WEBHOOK_URL"),
    (NotificationChannel.SLACK, "SLACK_NOTIFICATIONS_ENABLED", "SLACK_WEBHOOK_URL"),
    (
        NotificationChannel.DISCORD,
        "DISCORD_NOTIFICATIONS_ENABLED",
        "DISCORD_WEBHOOK_URL",
    ),
    (
        NotificationChannel.GOOGLE_CHAT,
        "GOOGLE_CHAT_NOTIFICATIONS_ENABLED",
        "GOOGLE_CHAT_WEBHOOK_URL",
    ),
    (NotificationChannel.WEBHOOK, "NOTIFY_WEBHOOK_ENABLED", "NOTIFY_WEBHOOK_URL"),
]


def _parse_env_file(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser for the project .env file (no dependency)."""
    result: dict[str, str] = {}
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"")
            if key:
                result[key] = value
    except OSError as exc:
        logger.debug("[Notifications] Could not read env file %s: %s", path, exc)
    return result


class NotificationService:
    """Resolves enabled channels and dispatches notifications to all of them."""

    def __init__(self, channels: list[ChannelConfig]):
        self.channels = channels

    @classmethod
    def from_env(cls, project_path: str | Path | None = None) -> NotificationService:
        """Build the service from os.environ, with project .env as fallback.

        Args:
            project_path: Project root; when given, ``.workpilot/.env`` is read
                for any key missing from the process environment.
        """
        file_vars: dict[str, str] = {}
        if project_path:
            env_file = Path(project_path) / ".workpilot" / ".env"
            if env_file.exists():
                file_vars = _parse_env_file(env_file)

        def get(key: str) -> str:
            value = os.environ.get(key, "").strip()
            return value if value else file_vars.get(key, "").strip()

        channels: list[ChannelConfig] = []
        for channel, enabled_key, url_key in _CHANNEL_ENV_KEYS:
            if get(enabled_key).lower() != "true":
                continue
            url = get(url_key)
            if not url:
                logger.warning(
                    "[Notifications] %s enabled but %s is empty — skipping",
                    channel.value,
                    url_key,
                )
                continue
            channels.append(ChannelConfig(channel=channel, webhook_url=url))

        return cls(channels)

    @property
    def is_configured(self) -> bool:
        """True when at least one channel is enabled and has a webhook URL."""
        return bool(self.channels)

    def send_pr_ready(self, notif: PRReadyNotification) -> list[ChannelResult]:
        """Announce a finished task / freshly created PR on every channel.

        Never raises — delivery failures are logged and returned per channel.
        """
        results: list[ChannelResult] = []
        for config in self.channels:
            try:
                results.append(
                    send_to_channel(config.channel, config.webhook_url, notif)
                )
            except Exception as exc:  # noqa: BLE001 — never break the caller
                logger.warning(
                    "[Notifications] %s delivery raised: %s", config.channel.value, exc
                )
                results.append(
                    ChannelResult(channel=config.channel, success=False, error=str(exc))
                )
        return results
