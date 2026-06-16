"""Multi-channel notification service.

Sends rich "PR ready" announcements (and other events) to Microsoft Teams,
Slack, Discord, Google Chat and generic webhooks.

Usage:
    from services.notifications import NotificationService, PRReadyNotification

    service = NotificationService.from_env(project_path)
    service.send_pr_ready(PRReadyNotification(...))
"""

from .models import ChannelResult, NotificationChannel, PRReadyNotification
from .service import NotificationService

__all__ = [
    "ChannelResult",
    "NotificationChannel",
    "NotificationService",
    "PRReadyNotification",
]
