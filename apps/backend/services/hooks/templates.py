"""
Event-Driven Hooks System — Pre-configured Templates Library

Templates de hooks pré-configurés prêts à l'emploi.
"""

from .models import HookTemplate


def get_hook_templates() -> list[HookTemplate]:
    """Return all available hook templates."""
    return [
        # ─── Automation ───────────────────────────────────────────────────
        HookTemplate(
            id="tpl-auto-lint-on-save",
            name="Auto-Lint on Save",
            description="Automatically run linter when a file is saved. Fix lint errors automatically if possible.",
            category="automation",
            icon="🧹",
            tags=["lint", "auto-fix", "quality", "save"],
            popularity=95,
            triggers=[
                {
                    "id": "t1",
                    "type": "file_saved",
                    "conditions": [
                        {
                            "field": "file_extension",
                            "operator": "matches",
                            "value": "\\.(ts|tsx|js|jsx|py|vue|svelte)$",
                        }
                    ],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_lint",
                    "config": {"auto_fix": True, "linter": "auto-detect"},
                    "delay_ms": 500,
                    "timeout_ms": 15000,
                    "position": {"x": 350, "y": 100},
                }
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                }
            ],
        ),
        HookTemplate(
            id="tpl-auto-fix-lint-errors",
            name="Auto-Fix Lint Errors",
            description="When lint errors are detected, automatically attempt to fix them using AI agent.",
            category="automation",
            icon="🔧",
            tags=["lint", "auto-fix", "agent", "quality"],
            popularity=88,
            triggers=[
                {
                    "id": "t1",
                    "type": "lint_error",
                    "conditions": [],
                    "config": {"min_severity": "warning"},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_agent",
                    "config": {
                        "agent_type": "coder",
                        "instructions": "Fix the lint errors in the specified files. Apply auto-fixable rules first, then address remaining issues.",
                    },
                    "timeout_ms": 60000,
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_notification",
                    "config": {
                        "title": "Lint Auto-Fix",
                        "message": "Lint errors have been automatically fixed.",
                        "type": "success",
                    },
                    "position": {"x": 650, "y": 50},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "a1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
            ],
        ),
        # ─── Quality ─────────────────────────────────────────────────────
        HookTemplate(
            id="tpl-generate-tests-new-function",
            name="Generate Tests After New Function",
            description="Automatically generate unit tests when a new function or method is created.",
            category="quality",
            icon="🧪",
            tags=["test", "generation", "quality", "tdd"],
            popularity=92,
            triggers=[
                {
                    "id": "t1",
                    "type": "file_saved",
                    "conditions": [
                        {
                            "field": "file_extension",
                            "operator": "matches",
                            "value": "\\.(ts|tsx|js|jsx|py)$",
                        }
                    ],
                    "config": {"detect_new_functions": True},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "generate_tests",
                    "config": {
                        "test_type": "unit",
                        "max_tests_per_function": 3,
                        "framework": "auto-detect",
                    },
                    "timeout_ms": 120000,
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_notification",
                    "config": {
                        "title": "Tests Generated",
                        "message": "Unit tests have been generated for new functions.",
                        "type": "info",
                    },
                    "position": {"x": 650, "y": 50},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "a1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
            ],
        ),
        HookTemplate(
            id="tpl-run-tests-on-save",
            name="Run Tests on Save",
            description="Run related test files when source code is saved.",
            category="quality",
            icon="✅",
            tags=["test", "save", "feedback", "quality"],
            popularity=90,
            triggers=[
                {
                    "id": "t1",
                    "type": "file_saved",
                    "conditions": [
                        {
                            "field": "file_extension",
                            "operator": "matches",
                            "value": "\\.(ts|tsx|js|jsx|py)$",
                        }
                    ],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_tests",
                    "config": {"scope": "related", "watch": False},
                    "timeout_ms": 60000,
                    "position": {"x": 350, "y": 100},
                }
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        # ─── Documentation ────────────────────────────────────────────────
        HookTemplate(
            id="tpl-update-docs-api-change",
            name="Update Docs After API Change",
            description="Automatically update API documentation when endpoint files are modified.",
            category="documentation",
            icon="📝",
            tags=["docs", "api", "auto-update", "documentation"],
            popularity=85,
            triggers=[
                {
                    "id": "t1",
                    "type": "file_saved",
                    "conditions": [
                        {"field": "file_path", "operator": "contains", "value": "api"},
                        {
                            "field": "file_extension",
                            "operator": "matches",
                            "value": "\\.(py|ts|js)$",
                        },
                    ],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_agent",
                    "config": {
                        "agent_type": "tech-writer",
                        "instructions": "Update the API documentation to reflect recent changes in the endpoint files.",
                    },
                    "timeout_ms": 120000,
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "update_docs",
                    "config": {"doc_type": "api", "format": "openapi"},
                    "position": {"x": 350, "y": 180},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        # ─── Notification ─────────────────────────────────────────────────
        HookTemplate(
            id="tpl-notify-build-failure",
            name="Notify on Build Failure",
            description="Send a Slack/notification when a build fails.",
            category="notification",
            icon="🔔",
            tags=["notification", "slack", "build", "failure", "alert"],
            popularity=87,
            triggers=[
                {
                    "id": "t1",
                    "type": "build_failed",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "send_notification",
                    "config": {
                        "title": "Build Failed",
                        "message": "Build failed — check logs for details.",
                        "type": "error",
                    },
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_slack",
                    "config": {
                        "channel": "#builds",
                        "message": "🚨 Build failed: {{build_name}} — {{error_summary}}",
                    },
                    "position": {"x": 350, "y": 180},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        HookTemplate(
            id="tpl-notify-pr-opened",
            name="Notify on PR Opened",
            description="Send notifications when a new pull request is opened.",
            category="notification",
            icon="📬",
            tags=["notification", "pr", "github", "alert"],
            popularity=78,
            triggers=[
                {
                    "id": "t1",
                    "type": "pr_opened",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "send_notification",
                    "config": {
                        "title": "New PR Opened",
                        "message": "PR #{{pr_number}}: {{pr_title}} by {{pr_author}}",
                        "type": "info",
                    },
                    "position": {"x": 350, "y": 100},
                }
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        HookTemplate(
            id="tpl-announce-pr-ready",
            name="Announce PR Ready on Channels",
            description=(
                "When a task is completed and its PR is created, announce it on "
                "Microsoft Teams, Slack and/or Discord with all PR details "
                "(task, branch, link). Remove the channels you don't use; each "
                "action takes its webhook URL from the project settings "
                "(Notifications section) or from config['url']."
            ),
            category="notification",
            icon="📣",
            tags=["notification", "pr", "teams", "slack", "discord", "task-done"],
            popularity=90,
            triggers=[
                {
                    "id": "t1",
                    "type": "pr_opened",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 150},
                }
            ],
            # No config["message"]: each action sends the rich per-channel PR
            # card built from the event data (task, branch, PR link, ...).
            actions=[
                {
                    "id": "a1",
                    "type": "send_teams",
                    "config": {},
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_slack",
                    "config": {},
                    "position": {"x": 350, "y": 150},
                },
                {
                    "id": "a3",
                    "type": "send_discord",
                    "config": {},
                    "position": {"x": 350, "y": 250},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a3",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        # ─── CI/CD ────────────────────────────────────────────────────────
        HookTemplate(
            id="tpl-auto-review-pr",
            name="Auto-Review PR with AI",
            description="Automatically run AI code review when a PR is opened or updated.",
            category="ci_cd",
            icon="🤖",
            tags=["pr", "review", "ai", "quality", "ci"],
            popularity=91,
            triggers=[
                {
                    "id": "t1",
                    "type": "pr_opened",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_agent",
                    "config": {
                        "agent_type": "reviewer",
                        "instructions": "Review this PR for code quality, security, performance, and best practices.",
                    },
                    "timeout_ms": 180000,
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "send_notification",
                    "config": {
                        "title": "AI Review Complete",
                        "message": "AI code review results are available for PR #{{pr_number}}.",
                        "type": "info",
                    },
                    "position": {"x": 650, "y": 50},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "a1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
            ],
        ),
        HookTemplate(
            id="tpl-auto-deploy-on-merge",
            name="Auto Deploy on Merge",
            description="Trigger deployment pipeline when a PR is merged to main branch.",
            category="ci_cd",
            icon="🚀",
            tags=["deploy", "merge", "ci", "pipeline", "automation"],
            popularity=82,
            triggers=[
                {
                    "id": "t1",
                    "type": "pr_merged",
                    "conditions": [
                        {"field": "base_branch", "operator": "equals", "value": "main"}
                    ],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "trigger_pipeline",
                    "config": {"pipeline": "deploy", "environment": "staging"},
                    "timeout_ms": 300000,
                    "position": {"x": 350, "y": 100},
                }
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        # ─── Dependency ───────────────────────────────────────────────────
        HookTemplate(
            id="tpl-dependency-update-alert",
            name="Dependency Update Alert",
            description="Alert when outdated or vulnerable dependencies are detected.",
            category="notification",
            icon="📦",
            tags=["dependency", "security", "update", "alert"],
            popularity=75,
            triggers=[
                {
                    "id": "t1",
                    "type": "dependency_outdated",
                    "conditions": [],
                    "config": {"check_interval_hours": 24},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "send_notification",
                    "config": {
                        "title": "Dependency Alert",
                        "message": "{{count}} outdated dependencies detected. {{critical_count}} have security vulnerabilities.",
                        "type": "warning",
                    },
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "create_spec",
                    "config": {
                        "spec_type": "update_plan",
                        "title": "Dependency Update Plan",
                    },
                    "position": {"x": 350, "y": 180},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "t1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
            ],
        ),
        # ─── Advanced Chains ──────────────────────────────────────────────
        HookTemplate(
            id="tpl-full-qa-on-commit",
            name="Full QA Pipeline on Commit",
            description="Run lint, tests, and AI review in sequence when code is committed.",
            category="ci_cd",
            icon="🔗",
            tags=["qa", "lint", "test", "review", "chain", "ci"],
            popularity=80,
            triggers=[
                {
                    "id": "t1",
                    "type": "commit_pushed",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 150},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_lint",
                    "config": {"auto_fix": False},
                    "timeout_ms": 15000,
                    "position": {"x": 300, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "run_tests",
                    "config": {"scope": "all"},
                    "timeout_ms": 120000,
                    "position": {"x": 550, "y": 50},
                },
                {
                    "id": "a3",
                    "type": "run_agent",
                    "config": {
                        "agent_type": "reviewer",
                        "instructions": "Review the latest commit for quality issues.",
                    },
                    "timeout_ms": 120000,
                    "position": {"x": 550, "y": 200},
                },
                {
                    "id": "a4",
                    "type": "send_notification",
                    "config": {
                        "title": "QA Complete",
                        "message": "Full QA pipeline completed for commit {{commit_sha}}.",
                        "type": "success",
                    },
                    "position": {"x": 800, "y": 125},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "a1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
                {
                    "source_id": "a1",
                    "target_id": "a3",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
                {
                    "source_id": "a2",
                    "target_id": "a4",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
                {
                    "source_id": "a3",
                    "target_id": "a4",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
            ],
        ),
        HookTemplate(
            id="tpl-self-healing-tests",
            name="Self-Healing: Auto-Fix Failing Tests",
            description="When tests fail, automatically analyze the failure and attempt to fix the code using an AI agent.",
            category="automation",
            icon="🩹",
            tags=["self-healing", "test", "auto-fix", "agent", "quality"],
            popularity=86,
            triggers=[
                {
                    "id": "t1",
                    "type": "test_failed",
                    "conditions": [],
                    "config": {},
                    "position": {"x": 50, "y": 100},
                }
            ],
            actions=[
                {
                    "id": "a1",
                    "type": "run_agent",
                    "config": {
                        "agent_type": "coder",
                        "instructions": "Analyze the test failure and fix the source code. Do not modify tests unless they are clearly wrong.",
                    },
                    "timeout_ms": 180000,
                    "max_retries": 1,
                    "position": {"x": 350, "y": 50},
                },
                {
                    "id": "a2",
                    "type": "run_tests",
                    "config": {"scope": "failed"},
                    "timeout_ms": 60000,
                    "position": {"x": 650, "y": 50},
                },
                {
                    "id": "a3",
                    "type": "send_notification",
                    "config": {
                        "title": "Self-Healing",
                        "message": "Tests fixed automatically!",
                        "type": "success",
                    },
                    "position": {"x": 950, "y": 50},
                },
            ],
            connections=[
                {
                    "source_id": "t1",
                    "target_id": "a1",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "always",
                },
                {
                    "source_id": "a1",
                    "target_id": "a2",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
                {
                    "source_id": "a2",
                    "target_id": "a3",
                    "source_handle": "output",
                    "target_handle": "input",
                    "condition": "on_success",
                },
            ],
        ),
    ]


def get_templates_by_category() -> dict[str, list[HookTemplate]]:
    """Return templates grouped by category."""
    result: dict[str, list[HookTemplate]] = {}
    for tpl in get_hook_templates():
        result.setdefault(tpl.category, []).append(tpl)
    return result


def get_template_by_id(template_id: str) -> HookTemplate | None:
    """Return a template by its ID."""
    for tpl in get_hook_templates():
        if tpl.id == template_id:
            return tpl
    return None
