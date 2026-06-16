"""Tests du service de notifications multi-canaux (PR prête / tâche terminée)."""

import asyncio
from unittest.mock import patch

import pytest
from services.hooks.hook_service import HookService
from services.hooks.models import (
    Action,
    ActionType,
    Hook,
    HookEvent,
    Trigger,
    TriggerType,
)
from services.notifications import (
    NotificationChannel,
    NotificationService,
    PRReadyNotification,
)
from services.notifications.channels import (
    build_payload,
    post_json,
    validate_webhook_url,
)
from services.notifications.service import _parse_env_file


@pytest.fixture
def notif():
    return PRReadyNotification(
        task_title="Limiter le numéro de TVA à 18 caractères",
        task_description="Validation côté formulaire et API",
        pr_url="https://github.com/acme/repo/pull/42",
        project_name="MeCa",
        branch="feature/tva-18",
        target_branch="develop",
        spec_id="001-tva",
    )


# ── Payload builders ────────────────────────────────────────────────────────


def test_teams_payload_is_adaptive_card_with_pr_link(notif):
    payload = build_payload(NotificationChannel.TEAMS, notif)
    card = payload["attachments"][0]["content"]
    assert card["type"] == "AdaptiveCard"
    texts = [b.get("text", "") for b in card["body"]]
    assert notif.task_title in texts
    assert card["actions"][0]["url"] == notif.pr_url


def test_slack_payload_has_blocks_and_button(notif):
    payload = build_payload(NotificationChannel.SLACK, notif)
    assert notif.task_title in payload["text"] or notif.pr_url in payload["text"]
    types = [b["type"] for b in payload["blocks"]]
    assert "header" in types
    actions = next(b for b in payload["blocks"] if b["type"] == "actions")
    assert actions["elements"][0]["url"] == notif.pr_url


def test_discord_payload_has_embed_with_fields(notif):
    payload = build_payload(NotificationChannel.DISCORD, notif)
    embed = payload["embeds"][0]
    assert embed["title"] == notif.task_title
    assert embed["url"] == notif.pr_url
    field_values = [f["value"] for f in embed["fields"]]
    assert notif.branch in field_values
    assert notif.pr_url in field_values


def test_google_chat_payload_has_card_and_button(notif):
    payload = build_payload(NotificationChannel.GOOGLE_CHAT, notif)
    widgets = payload["cardsV2"][0]["card"]["sections"][0]["widgets"]
    button = next(w for w in widgets if "buttonList" in w)
    assert (
        button["buttonList"]["buttons"][0]["onClick"]["openLink"]["url"] == notif.pr_url
    )


def test_generic_payload_is_flat_event_dict(notif):
    payload = build_payload(NotificationChannel.WEBHOOK, notif)
    assert payload["event"] == "pr_ready"
    assert payload["pr_url"] == notif.pr_url
    assert payload["task_title"] == notif.task_title
    assert payload["branch"] == "feature/tva-18"


def test_payloads_without_pr_url_have_no_link_action():
    bare = PRReadyNotification(task_title="Tâche sans PR")
    teams = build_payload(NotificationChannel.TEAMS, bare)
    assert teams["attachments"][0]["content"]["actions"] == []
    slack = build_payload(NotificationChannel.SLACK, bare)
    assert all(b["type"] != "actions" for b in slack["blocks"])


# ── SSRF guard (validate_webhook_url / post_json) ───────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata (link-local)
        "http://127.0.0.1:6379/",  # loopback
        "http://localhost/admin",  # loopback by name
        "http://10.0.0.5/internal",  # private range
        "http://192.168.1.1/",  # private range
        "http://172.16.0.1/",  # private range
        "http://0.0.0.0/",  # unspecified
        "ftp://example.com/x",  # disallowed scheme
        "file:///etc/passwd",  # disallowed scheme
        "not-a-url",  # no host / scheme
    ],
)
def test_validate_webhook_url_rejects_internal_and_bad_targets(url):
    with pytest.raises(ValueError):
        validate_webhook_url(url)


def test_validate_webhook_url_allows_public_https():
    # Should not raise for a host resolving to a public address.
    # Resolver is mocked so the test stays deterministic and offline.
    public = [(2, 1, 6, "", ("93.184.216.34", 0))]  # AF_INET, public IP
    with patch(
        "services.notifications.channels.socket.getaddrinfo", return_value=public
    ):
        validate_webhook_url("https://hooks.slack.com/services/X")


def test_validate_webhook_url_rejects_dns_rebinding_to_private():
    # A public-looking host that resolves to a private IP must be rejected.
    private = [(2, 1, 6, "", ("10.0.0.5", 0))]  # AF_INET, private IP
    with patch(
        "services.notifications.channels.socket.getaddrinfo", return_value=private
    ):
        with pytest.raises(ValueError):
            validate_webhook_url("https://evil.example.com/hook")


def test_post_json_blocks_ssrf_without_making_request():
    # A blocked URL must never reach urllib.request.urlopen.
    with patch("services.notifications.channels.urllib.request.urlopen") as mock_open:
        success, status_code, error = post_json(
            "http://169.254.169.254/latest/meta-data/", {"event": "test"}
        )
    assert success is False
    assert status_code is None
    assert "non-routable" in error
    mock_open.assert_not_called()


# ── NotificationService.from_env ────────────────────────────────────────────


def _clear_channel_env(monkeypatch):
    for key in (
        "TEAMS_NOTIFICATIONS_ENABLED",
        "TEAMS_WEBHOOK_URL",
        "SLACK_NOTIFICATIONS_ENABLED",
        "SLACK_WEBHOOK_URL",
        "DISCORD_NOTIFICATIONS_ENABLED",
        "DISCORD_WEBHOOK_URL",
        "GOOGLE_CHAT_NOTIFICATIONS_ENABLED",
        "GOOGLE_CHAT_WEBHOOK_URL",
        "NOTIFY_WEBHOOK_ENABLED",
        "NOTIFY_WEBHOOK_URL",
    ):
        monkeypatch.delenv(key, raising=False)


def test_from_env_reads_enabled_channels(monkeypatch):
    _clear_channel_env(monkeypatch)
    monkeypatch.setenv("SLACK_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/X")
    monkeypatch.setenv("DISCORD_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/Y")
    # Enabled but missing URL → skipped
    monkeypatch.setenv("TEAMS_NOTIFICATIONS_ENABLED", "true")

    service = NotificationService.from_env()
    channels = {c.channel for c in service.channels}
    assert channels == {NotificationChannel.SLACK, NotificationChannel.DISCORD}
    assert service.is_configured


def test_from_env_not_configured_when_nothing_enabled(monkeypatch):
    _clear_channel_env(monkeypatch)
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/X")
    service = NotificationService.from_env()
    assert not service.is_configured


def test_from_env_falls_back_to_project_env_file(monkeypatch, tmp_path):
    _clear_channel_env(monkeypatch)
    workpilot = tmp_path / ".workpilot"
    workpilot.mkdir()
    (workpilot / ".env").write_text(
        "# comment\n"
        "TEAMS_NOTIFICATIONS_ENABLED=true\n"
        'TEAMS_WEBHOOK_URL="https://example.webhook.office.com/abc"\n',
        encoding="utf-8",
    )

    service = NotificationService.from_env(tmp_path)
    assert [c.channel for c in service.channels] == [NotificationChannel.TEAMS]
    assert service.channels[0].webhook_url == "https://example.webhook.office.com/abc"


def test_parse_env_file_ignores_comments_and_quotes(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# A=ignored\nB=plain\nC='quoted'\nINVALID LINE\n D = spaced \n",
        encoding="utf-8",
    )
    parsed = _parse_env_file(env)
    assert parsed == {"B": "plain", "C": "quoted", "D": "spaced"}


def test_send_pr_ready_dispatches_to_all_channels(monkeypatch, notif):
    _clear_channel_env(monkeypatch)
    monkeypatch.setenv("SLACK_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/X")
    monkeypatch.setenv("TEAMS_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("TEAMS_WEBHOOK_URL", "https://example.webhook.office.com/abc")

    with patch(
        "services.notifications.channels.post_json", return_value=(True, 200, None)
    ) as mock_post:
        results = NotificationService.from_env().send_pr_ready(notif)

    assert len(results) == 2
    assert all(r.success for r in results)
    urls = {call.args[0] for call in mock_post.call_args_list}
    assert urls == {
        "https://hooks.slack.com/services/X",
        "https://example.webhook.office.com/abc",
    }


def test_send_pr_ready_reports_failure_without_raising(monkeypatch, notif):
    _clear_channel_env(monkeypatch)
    monkeypatch.setenv("DISCORD_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/Y")

    with patch(
        "services.notifications.channels.post_json",
        return_value=(False, 404, "HTTP 404: Not Found"),
    ):
        results = NotificationService.from_env().send_pr_ready(notif)

    assert len(results) == 1
    assert not results[0].success
    assert results[0].status_code == 404


# ── Hook engine channel actions ─────────────────────────────────────────────


def _make_hook(action_type: ActionType, config: dict) -> Hook:
    return Hook(
        name="test-hook",
        triggers=[Trigger(type=TriggerType.PR_OPENED)],
        actions=[Action(type=action_type, config=config)],
    )


def _run_hook(hook: Hook, event: HookEvent) -> dict:
    service = HookService.__new__(HookService)  # skip singleton/_load
    service._hooks = {}
    service._executions = []
    service._listeners = []
    service._max_executions = 500
    with (
        patch.object(service, "_save_hooks"),
        patch.object(service, "_save_executions"),
    ):
        execution = asyncio.run(service._execute_hook(hook, event))
    return execution.to_dict()


@pytest.fixture
def pr_event(notif):
    return HookEvent(type=TriggerType.PR_OPENED, data=notif.to_event_data())


def test_hook_send_slack_with_message_posts_text(pr_event):
    hook = _make_hook(
        ActionType.SEND_SLACK,
        {
            "url": "https://hooks.slack.com/services/X",
            "message": "PR prête : {{pr_url}}",
        },
    )
    with patch(
        "services.hooks.hook_service.post_json", return_value=(True, 200, None)
    ) as mock_post:
        execution = _run_hook(hook, pr_event)

    assert execution["status"] == "success"
    url, payload = mock_post.call_args.args
    assert url == "https://hooks.slack.com/services/X"
    assert payload == {"text": "PR prête : https://github.com/acme/repo/pull/42"}


def test_hook_send_teams_without_message_sends_rich_pr_card(pr_event):
    hook = _make_hook(
        ActionType.SEND_TEAMS, {"url": "https://example.webhook.office.com/abc"}
    )
    with patch(
        "services.hooks.hook_service.post_json", return_value=(True, 200, None)
    ) as mock_post:
        execution = _run_hook(hook, pr_event)

    assert execution["status"] == "success"
    _, payload = mock_post.call_args.args
    card = payload["attachments"][0]["content"]
    assert card["actions"][0]["url"] == "https://github.com/acme/repo/pull/42"


def test_hook_send_discord_uses_env_url_fallback(pr_event, monkeypatch):
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/Y")
    hook = _make_hook(ActionType.SEND_DISCORD, {"message": "Nouvelle PR !"})
    with patch(
        "services.hooks.hook_service.post_json", return_value=(True, 204, None)
    ) as mock_post:
        execution = _run_hook(hook, pr_event)

    assert execution["status"] == "success"
    url, payload = mock_post.call_args.args
    assert url == "https://discord.com/api/webhooks/Y"
    assert payload == {"content": "Nouvelle PR !"}


def test_hook_send_channel_fails_without_url(pr_event, monkeypatch):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    hook = _make_hook(ActionType.SEND_SLACK, {"message": "hello"})
    execution = _run_hook(hook, pr_event)
    assert execution["status"] == "failed"
    assert "SLACK_WEBHOOK_URL" in execution["action_results"][0]["error"]


def test_hook_send_webhook_posts_interpolated_payload(pr_event):
    hook = _make_hook(
        ActionType.SEND_WEBHOOK,
        {
            "url": "https://example.com/hook",
            "payload": {"title": "{{task_title}}", "link": "{{pr_url}}", "n": 1},
        },
    )
    with patch(
        "services.hooks.hook_service.post_json", return_value=(True, 200, None)
    ) as mock_post:
        execution = _run_hook(hook, pr_event)

    assert execution["status"] == "success"
    url, payload = mock_post.call_args.args
    assert url == "https://example.com/hook"
    assert payload == {
        "title": "Limiter le numéro de TVA à 18 caractères",
        "link": "https://github.com/acme/repo/pull/42",
        "n": 1,
    }


def test_hook_send_webhook_defaults_to_event_dict(pr_event):
    hook = _make_hook(ActionType.SEND_WEBHOOK, {"url": "https://example.com/hook"})
    with patch(
        "services.hooks.hook_service.post_json", return_value=(True, 200, None)
    ) as mock_post:
        execution = _run_hook(hook, pr_event)

    assert execution["status"] == "success"
    _, payload = mock_post.call_args.args
    assert payload["type"] == "pr_opened"
    assert payload["data"]["pr_url"] == "https://github.com/acme/repo/pull/42"
