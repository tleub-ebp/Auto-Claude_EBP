"""
Service de complétion de tâches
================================

Ce service gère la création automatique de PR lorsqu'une tâche passe en statut "done".

Workflow:
1. Détecte quand une tâche passe en statut "done"
2. Push la branche vers origin
3. Crée une PR pour validation humaine
4. Associe l'URL de la PR à la tâche
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from core.worktree import WorktreeManager

logger = logging.getLogger(__name__)


def _get_app_language() -> str:
    """Get the current app language from environment variable set by the frontend."""
    return os.environ.get("APP_LANGUAGE", "en")


# ── i18n strings for PR title & body ──────────────────────────────────────
_PR_STRINGS: dict[str, dict[str, str]] = {
    "en": {
        # Title
        "title_prefix": "feat",
        # Body sections
        "header": "Completed task — Human review required",
        "task_label": "Task",
        "description_label": "Description",
        "summary_section": "Summary",
        "changes_section": "Changes overview",
        "changes_placeholder": "Describe the main changes introduced by this task.",
        "checklist_section": "Review checklist",
        "check_standards": "Code follows project standards",
        "check_tests": "Tests pass (if applicable)",
        "check_coverage": "Unit + integration test coverage meets the required threshold (100%)",
        "check_docs": "Documentation is up to date",
        "check_coherent": "Changes are consistent with the task",
        "check_regression": "No regression detected",
        "warning": "This PR requires human validation before merge.",
        "footer": "PR created automatically by WorkPilot AI",
        "no_description": "No description provided.",
    },
    "fr": {
        # Title
        "title_prefix": "feat",
        # Body sections
        "header": "Tâche terminée — Vérification humaine requise",
        "task_label": "Tâche",
        "description_label": "Description",
        "summary_section": "Résumé",
        "changes_section": "Aperçu des changements",
        "changes_placeholder": "Décrivez les changements principaux introduits par cette tâche.",
        "checklist_section": "Checklist de vérification",
        "check_standards": "Le code respecte les standards du projet",
        "check_tests": "Les tests passent (si applicables)",
        "check_coverage": "La couverture des tests unitaires + intégration atteint le seuil requis (100%)",
        "check_docs": "La documentation est à jour",
        "check_coherent": "Les changements sont cohérents avec la tâche",
        "check_regression": "Aucune régression détectée",
        "warning": "Cette PR nécessite une validation humaine avant merge.",
        "footer": "PR créée automatiquement par WorkPilot AI",
        "no_description": "Aucune description fournie.",
    },
}


def _t(key: str, lang: str | None = None) -> str:
    """Return a translated string for the given key and language."""
    lang = lang or _get_app_language()
    strings = _PR_STRINGS.get(lang, _PR_STRINGS["en"])
    return strings.get(key, _PR_STRINGS["en"].get(key, key))


# ── Teams notification strings ─────────────────────────────────────────────
_TEAMS_STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "task_done_title": "✅ Task completed",
        "task_done_body": "The task has been completed and a PR has been created for human review.",
        "pr_label": "Pull Request",
        "review_prompt": "Click below to review the changes.",
        "review_button": "Open PR",
        "project_label": "Project",
        "footer": "WorkPilot AI",
    },
    "fr": {
        "task_done_title": "✅ Tâche terminée",
        "task_done_body": "La tâche est terminée et une PR a été créée pour validation humaine.",
        "pr_label": "Pull Request",
        "review_prompt": "Cliquez ci-dessous pour examiner les changements.",
        "review_button": "Ouvrir la PR",
        "project_label": "Projet",
        "footer": "WorkPilot AI",
    },
}


def _send_teams_notification(
    task_title: str,
    pr_url: str | None,
    project_path: Path,
) -> None:
    """Send a Teams Incoming Webhook notification when a task is done."""
    webhook_url = os.environ.get("TEAMS_WEBHOOK_URL", "").strip()
    if (
        not webhook_url
        or os.environ.get("TEAMS_NOTIFICATIONS_ENABLED", "").lower() != "true"
    ):
        return

    lang = _get_app_language()
    s = _TEAMS_STRINGS.get(lang, _TEAMS_STRINGS["en"])
    project_name = project_path.name

    body: list[dict] = [
        {
            "type": "TextBlock",
            "text": s["task_done_title"],
            "weight": "bolder",
            "size": "large",
        },
        {"type": "TextBlock", "text": task_title, "weight": "bolder", "wrap": True},
        {
            "type": "TextBlock",
            "text": s["task_done_body"],
            "wrap": True,
            "spacing": "small",
        },
        {
            "type": "FactSet",
            "facts": [{"title": s["project_label"], "value": project_name}],
            "spacing": "medium",
        },
    ]

    actions: list[dict] = []
    if pr_url:
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
                "url": pr_url,
            }
        )

    payload = {
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

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            webhook_url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status not in (200, 202):
                logger.warning(f"[Teams] Webhook returned HTTP {resp.status}")
            else:
                logger.info("[Teams] Notification sent successfully")
    except Exception as exc:
        logger.warning(f"[Teams] Failed to send notification: {exc}")


class TaskCompletionResult(TypedDict):
    """Résultat de la complétion d'une tâche"""

    success: bool
    pr_url: str | None
    pr_already_exists: bool
    error: str | None


@dataclass
class TaskCompletionService:
    """Service de gestion de la complétion des tâches"""

    project_path: Path
    base_branch: str = "develop"

    def __post_init__(self):
        """Initialise le gestionnaire de worktree"""
        self.worktree_manager = WorktreeManager(
            project_dir=self.project_path, base_branch=self.base_branch
        )

    def complete_task(
        self,
        spec_id: str,
        task_title: str,
        task_description: str | None = None,
        target_branch: str | None = None,
    ) -> TaskCompletionResult:
        """
        Complète une tâche en créant une PR pour validation humaine.

        Cette méthode:
        1. Push la branche de la tâche vers origin
        2. Crée une PR vers la branche cible (develop par défaut)
        3. La PR reste ouverte pour validation humaine (pas de merge automatique)

        Args:
            spec_id: ID de la spec (correspond au nom du worktree)
            task_title: Titre de la tâche
            task_description: Description optionnelle de la tâche
            target_branch: Branche cible pour la PR (défaut: self.base_branch)

        Returns:
            TaskCompletionResult avec:
                - success: True si la PR a été créée
                - pr_url: URL de la PR créée
                - pr_already_exists: True si une PR existe déjà
                - error: Message d'erreur si échec
        """
        logger.info(
            f"[TaskCompletionService] Complétion de la tâche: {spec_id} - {task_title}"
        )

        target = target_branch or self.base_branch

        # Étape 0: Commit any uncommitted changes in the worktree
        has_changes, changed_files = self.worktree_manager._has_uncommitted_changes(
            spec_id
        )
        if has_changes:
            logger.info(
                f"[TaskCompletionService] Found {len(changed_files)} uncommitted files, committing..."
            )
            commit_ok = self.worktree_manager.commit_in_worktree(
                spec_id, f"auto-claude: {task_title}"
            )
            if not commit_ok:
                error_msg = "Failed to commit uncommitted changes before push"
                logger.error(f"[TaskCompletionService] {error_msg}")
                return TaskCompletionResult(
                    success=False,
                    pr_url=None,
                    pr_already_exists=False,
                    error=error_msg,
                )
            logger.info(f"[TaskCompletionService] Committed {len(changed_files)} files")

        # Étape 1: Push de la branche vers origin
        logger.info("[TaskCompletionService] Push de la branche vers origin...")
        push_result = self.worktree_manager.push_branch(spec_id, force=False)

        if not push_result["success"]:
            error_msg = f"Échec du push de la branche: {push_result.get('error', 'Erreur inconnue')}"
            logger.error(f"[TaskCompletionService] {error_msg}")
            return TaskCompletionResult(
                success=False,
                pr_url=None,
                pr_already_exists=False,
                error=error_msg,
            )

        logger.info(
            f"[TaskCompletionService] Branche {push_result['branch']} poussée avec succès"
        )

        # Étape 2: Création de la PR avec template de vérification humaine
        pr_title = self._build_pr_title(task_title)
        pr_body = self._build_pr_body(task_title, task_description)

        logger.info(f"[TaskCompletionService] Création de la PR vers {target}...")
        pr_result = self.worktree_manager.create_pull_request(
            spec_name=spec_id,
            target_branch=target,
            title=pr_title,
            body=pr_body,
            draft=False,  # PR normale qui nécessite review
        )

        if not pr_result["success"]:
            error_msg = f"Échec de la création de la PR: {pr_result.get('error', 'Erreur inconnue')}"
            logger.error(f"[TaskCompletionService] {error_msg}")
            return TaskCompletionResult(
                success=False,
                pr_url=None,
                pr_already_exists=False,
                error=error_msg,
            )

        pr_url = pr_result.get("pr_url")
        pr_already_exists = pr_result.get("already_exists", False)

        if pr_already_exists:
            logger.info(f"[TaskCompletionService] PR déjà existante: {pr_url}")
        else:
            logger.info(f"[TaskCompletionService] PR créée avec succès: {pr_url}")

        # Send Teams notification (no-op if not configured)
        if not pr_already_exists:
            _send_teams_notification(task_title, pr_url, self.project_path)

        return TaskCompletionResult(
            success=True,
            pr_url=pr_url,
            pr_already_exists=pr_already_exists,
            error=None,
        )

    def _build_pr_title(self, task_title: str) -> str:
        """
        Build a conventional-commit style PR title.

        Format: ``feat: <task_title>``

        Args:
            task_title: Human-readable task title.

        Returns:
            Formatted PR title string.
        """
        prefix = _t("title_prefix")
        # Normalise: lowercase first char, strip trailing period
        title = task_title.strip()
        if title and title[0].isupper():
            title = title[0].lower() + title[1:]
        title = title.rstrip(".")
        return f"{prefix}: {title}"

    def _build_pr_body(self, task_title: str, task_description: str | None) -> str:
        """
        Build a rich Markdown PR body with a human-review checklist.

        Uses the ``_t()`` helper so the output is localised to the
        language configured by the frontend (``APP_LANGUAGE`` env var).

        Args:
            task_title: Human-readable task title.
            task_description: Optional longer description of the task.

        Returns:
            Formatted Markdown string for the PR body.
        """
        desc = task_description or _t("no_description")

        body_parts = [
            f"## 🤖 {_t('header')}",
            "",
            f"**{_t('task_label')}:** {task_title}",
            "",
            f"**{_t('description_label')}:** {desc}",
            "",
            f"### ✅ {_t('checklist_section')}",
            f"- [ ] {_t('check_standards')}",
            f"- [ ] {_t('check_tests')}",
            f"- [ ] {_t('check_coverage')}",
            f"- [ ] {_t('check_docs')}",
            f"- [ ] {_t('check_coherent')}",
            f"- [ ] {_t('check_regression')}",
            "",
            "---",
            f"⚠️ **{_t('warning')}**",
            "",
            f"_{_t('footer')}_",
        ]

        return "\n".join(body_parts)


def create_task_completion_service(
    project_path: str | Path, base_branch: str = "develop"
) -> TaskCompletionService:
    """
    Factory pour créer un service de complétion de tâches.

    Args:
        project_path: Chemin du projet Git
        base_branch: Branche de base (défaut: "develop")

    Returns:
        Instance de TaskCompletionService
    """
    return TaskCompletionService(
        project_path=Path(project_path), base_branch=base_branch
    )
