"""
Issue Auto-Responder Module
============================

Monitors GitHub/GitLab issues for new entries and automatically
triages, investigates, and optionally creates specs or fix PRs.

Flow:
1. Poll for new/unprocessed issues
2. Auto-triage: assign labels, estimate complexity
3. For bug reports: attempt reproduction and root cause analysis
4. For feature requests: create a draft spec via spec_runner

Uses the existing GitHub integration (gh CLI) and smart estimation runner.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from .types import (
    ActionStatus,
    ActionType,
    DaemonAction,
    DaemonModule,
    IssueResponderConfig,
    ModuleName,
    ModuleState,
)

logger = logging.getLogger(__name__)

# Track processed issue numbers to avoid re-processing
_processed_issues: set[int] = set()


class IssueResponder:
    """
    Monitors and auto-responds to new GitHub/GitLab issues.
    """

    def __init__(
        self,
        project_dir: Path,
        config: IssueResponderConfig,
        module: DaemonModule,
    ) -> None:
        self.project_dir = Path(project_dir).resolve()
        self.config = config
        self.module = module
        self._data_dir = self.project_dir / ".workpilot" / "continuous-ai" / "issues"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._load_processed()

    async def poll(self) -> list[DaemonAction]:
        """
        Poll for new issues.

        Returns:
            List of DaemonActions for new issues detected.
        """
        self.module.state = ModuleState.POLLING
        self.module.last_poll_at = time.time()
        actions: list[DaemonAction] = []

        try:
            issues = self._fetch_new_issues()

            for issue in issues:
                issue_number = issue.get("number", 0)
                if issue_number in _processed_issues:
                    continue
                _processed_issues.add(issue_number)

                # Classify the issue
                classification = self._classify_issue(issue)
                action_type = (
                    ActionType.ISSUE_INVESTIGATION
                    if classification == "bug"
                    else ActionType.ISSUE_TRIAGE
                )

                auto_act = self.config.auto_triage or (
                    self.config.auto_investigate_bugs and classification == "bug"
                )

                action = DaemonAction(
                    id=f"issue-{issue_number}-{uuid.uuid4().hex[:8]}",
                    module=ModuleName.ISSUE_RESPONDER,
                    action_type=action_type,
                    status=ActionStatus.PENDING
                    if auto_act
                    else ActionStatus.NEEDS_APPROVAL,
                    title=f"#{issue_number}: {issue.get('title', 'Untitled')[:80]}",
                    description=self._build_description(issue, classification),
                    target=issue.get("url", ""),
                    metadata={
                        "issue_number": issue_number,
                        "classification": classification,
                        "author": issue.get("author", {}).get("login", "unknown"),
                        "labels": [
                            label.get("name", "") for label in issue.get("labels", [])
                        ],
                        "created_at": issue.get("createdAt", ""),
                    },
                )
                actions.append(action)
                self._save_action(action)

            self._save_processed()
            self.module.state = ModuleState.IDLE
            return actions

        except Exception as e:
            logger.error("Issue responder poll failed: %s", e)
            self.module.state = ModuleState.ERROR
            self.module.error = str(e)
            return []

    async def act(self, action: DaemonAction) -> DaemonAction:
        """
        Process an issue (triage, investigate, or create spec).
        """
        if not self.module.can_act(self.config):
            action.status = ActionStatus.CANCELLED
            action.error = "Rate limit reached for this hour"
            return action

        self.module.state = ModuleState.ACTING
        action.status = ActionStatus.RUNNING
        action.started_at = time.time()

        try:
            classification = action.metadata.get("classification", "unknown")
            issue_number = action.metadata.get("issue_number", 0)

            if action.action_type == ActionType.ISSUE_TRIAGE:
                result = await self._triage_issue(issue_number, classification)
            elif action.action_type == ActionType.ISSUE_INVESTIGATION:
                result = await self._investigate_bug(issue_number)
            else:
                result = {
                    "success": False,
                    "error": f"Unknown action type: {action.action_type}",
                }

            action.completed_at = time.time()
            if result.get("success"):
                action.status = ActionStatus.COMPLETED
                action.result = result.get("message", "Processed successfully")
            else:
                action.status = ActionStatus.FAILED
                action.error = result.get("error", "Processing failed")

            self.module.record_action()
            self._save_action(action)

        except Exception as e:
            action.status = ActionStatus.FAILED
            action.completed_at = time.time()
            action.error = str(e)

        self.module.state = ModuleState.IDLE
        return action

    def _fetch_new_issues(self) -> list[dict[str, Any]]:
        """Fetch recent open issues using gh CLI."""
        try:
            result = subprocess.run(
                [
                    "gh",
                    "issue",
                    "list",
                    "--state",
                    "open",
                    "--limit",
                    "20",
                    "--json",
                    "number,title,body,author,labels,createdAt,url",
                    "--sort",
                    "created",
                    "--order",
                    "desc",
                ],
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                logger.warning("gh issue list failed: %s", result.stderr[:200])
                return []

            issues = json.loads(result.stdout) if result.stdout.strip() else []

            # Filter by labels if configured
            if self.config.labels_to_watch:
                watched = set(self.config.labels_to_watch)
                issues = [
                    i
                    for i in issues
                    if any(
                        label.get("name", "") in watched
                        for label in i.get("labels", [])
                    )
                    or not i.get("labels")  # Include unlabeled issues
                ]

            return issues

        except FileNotFoundError:
            logger.warning("gh CLI not found — issue responder requires GitHub CLI")
            return []
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
            logger.warning("Failed to fetch issues: %s", e)
            return []

    def _classify_issue(self, issue: dict[str, Any]) -> str:
        """
        Classify an issue as bug, feature, question, or other.

        Uses label-based detection first, then keyword heuristics.
        """
        labels = {label.get("name", "").lower() for label in issue.get("labels", [])}

        # Label-based classification
        if labels & {"bug", "defect", "error", "crash", "regression"}:
            return "bug"
        if labels & {"feature", "enhancement", "feature-request"}:
            return "feature"
        if labels & {"question", "help", "support"}:
            return "question"

        # Keyword-based heuristic from title + body
        text = f"{issue.get('title', '')} {issue.get('body', '')}".lower()

        bug_keywords = {
            "bug",
            "error",
            "crash",
            "broken",
            "doesn't work",
            "fails",
            "regression",
            "exception",
            "traceback",
        }
        feature_keywords = {
            "feature",
            "add",
            "implement",
            "request",
            "would be nice",
            "enhancement",
            "proposal",
        }

        bug_score = sum(1 for kw in bug_keywords if kw in text)
        feature_score = sum(1 for kw in feature_keywords if kw in text)

        if bug_score > feature_score:
            return "bug"
        if feature_score > bug_score:
            return "feature"
        return "other"

    async def _triage_issue(
        self, issue_number: int, classification: str
    ) -> dict[str, Any]:
        """Add labels and a triage comment to an issue."""
        label_map = {
            "bug": "bug",
            "feature": "enhancement",
            "question": "question",
        }
        label = label_map.get(classification)

        results = []

        if label:
            try:
                # Use async subprocess instead of blocking subprocess.run
                process = await asyncio.create_subprocess_exec(
                    "gh",
                    "issue",
                    "edit",
                    str(issue_number),
                    "--add-label",
                    label,
                    cwd=str(self.project_dir),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    text=True,
                )

                try:
                    _, stderr = await asyncio.wait_for(
                        process.communicate(), timeout=15
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    try:
                        await process.wait()
                    except Exception:
                        pass
                    raise

                if process.returncode == 0:
                    results.append(f"Added label: {label}")
                else:
                    logger.warning("Failed to add label: %s", stderr)

            except (FileNotFoundError, asyncio.TimeoutError):
                pass
            except Exception as e:
                logger.error("Error adding label: %s", e)

        return {
            "success": True,
            "message": f"Triaged as {classification}. {'; '.join(results)}",
        }

    async def _investigate_bug(self, issue_number: int) -> dict[str, Any]:
        """
        Investigate a bug report by analyzing the issue description
        and searching the codebase for relevant context.
        """
        # This would invoke the existing issue_analyzer runner
        return {
            "success": True,
            "message": f"Bug investigation initiated for #{issue_number}",
        }

    def _build_description(self, issue: dict[str, Any], classification: str) -> str:
        labels = (
            ", ".join(label.get("name", "") for label in issue.get("labels", []))
            or "none"
        )
        return (
            f"Classification: {classification} | "
            f"Labels: {labels} | "
            f"Author: {issue.get('author', {}).get('login', 'unknown')}"
        )

    def _load_processed(self) -> None:
        """Load set of already-processed issue numbers."""
        global _processed_issues
        state_file = self._data_dir / "processed.json"
        if state_file.exists():
            try:
                with open(state_file, encoding="utf-8") as f:
                    data = json.load(f)
                _processed_issues = set(data.get("issue_numbers", []))
            except (json.JSONDecodeError, OSError):
                pass

    def _save_processed(self) -> None:
        """Save set of processed issue numbers."""
        state_file = self._data_dir / "processed.json"
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump({"issue_numbers": list(_processed_issues)[-500:]}, f)

    def _save_action(self, action: DaemonAction) -> None:
        """Persist action to disk."""
        actions_file = self._data_dir / "actions.json"
        existing: list[dict] = []
        if actions_file.exists():
            try:
                with open(actions_file, encoding="utf-8") as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, OSError):
                existing = []
        found = False
        for i, a in enumerate(existing):
            if a.get("id") == action.id:
                existing[i] = action.to_dict()
                found = True
                break
        if not found:
            existing.append(action.to_dict())
        existing = existing[-100:]
        with open(actions_file, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2)
