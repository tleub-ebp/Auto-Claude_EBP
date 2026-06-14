"""Multi-channel notification service — data models."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class NotificationChannel(str, Enum):
    """Supported outbound notification channels."""

    TEAMS = "teams"
    SLACK = "slack"
    DISCORD = "discord"
    GOOGLE_CHAT = "google_chat"
    WEBHOOK = "webhook"  # generic JSON webhook


@dataclass
class PRReadyNotification:
    """All the information related to a finished task and its freshly created PR."""

    task_title: str
    pr_url: str | None = None
    task_description: str | None = None
    project_name: str | None = None
    branch: str | None = None
    target_branch: str | None = None
    spec_id: str | None = None

    def to_event_data(self) -> dict:
        """Flatten to a dict usable as webhook payload / hook event data."""
        return {
            "event": "pr_ready",
            "task_title": self.task_title,
            "task_description": self.task_description or "",
            "pr_url": self.pr_url or "",
            "project_name": self.project_name or "",
            "branch": self.branch or "",
            "target_branch": self.target_branch or "",
            "spec_id": self.spec_id or "",
        }


@dataclass
class ChannelResult:
    """Delivery outcome for a single channel."""

    channel: NotificationChannel
    success: bool
    status_code: int | None = None
    error: str | None = None


@dataclass
class ChannelConfig:
    """Resolved configuration for one channel."""

    channel: NotificationChannel
    webhook_url: str
    extra: dict = field(default_factory=dict)
