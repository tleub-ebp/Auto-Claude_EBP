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

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from core.worktree import WorktreeManager
from services.notifications import NotificationService, PRReadyNotification

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


def _announce_pr_ready(notif: PRReadyNotification, project_path: Path) -> None:
    """Announce a finished task / created PR on every configured channel.

    Dispatches to the multi-channel notification service (Teams, Slack,
    Discord, Google Chat, generic webhook) and emits a ``pr_opened`` event so
    user-defined hooks can react too. Never raises.
    """
    try:
        service = NotificationService.from_env(project_path)
        if service.is_configured:
            service.send_pr_ready(notif)
    except Exception as exc:
        logger.warning(f"[Notifications] Failed to send PR-ready notification: {exc}")

    # Emit hook event (user-defined hooks with a pr_opened trigger)
    try:
        from services.hooks.hook_service import HookService
        from services.hooks.models import HookEvent, TriggerType

        HookService.get_instance().emit_event_sync(
            HookEvent(
                type=TriggerType.PR_OPENED,
                data=notif.to_event_data(),
                source="task_completion",
            )
        )
    except Exception as exc:
        logger.warning(f"[Notifications] Failed to emit pr_opened hook event: {exc}")


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

        # Étape 0: Si une PR est déjà ouverte pour cette branche, on finalise
        # sans re-pousser. Cas fréquent : la branche a été poussée lors d'une
        # session précédente et le push échoue désormais (ex. PAT Azure DevOps
        # en lecture seule -> push refusé 403, alors que l'API REST de lecture
        # répond). La tâche est déjà « en revue » : il suffit de retrouver
        # l'URL de sa PR. Lookup best-effort, provider-aware, ne lève jamais.
        existing_pr_url = self.worktree_manager.find_existing_pr_url(spec_id, target)
        if existing_pr_url:
            logger.info(
                f"[TaskCompletionService] PR déjà existante, push ignoré: {existing_pr_url}"
            )
            return TaskCompletionResult(
                success=True,
                pr_url=existing_pr_url,
                pr_already_exists=True,
                error=None,
            )

        # Étape 1: Push de la branche + création de la PR/MR. On délègue au
        # dispatcher provider-aware (`push_and_create_pr`) qui route vers
        # GitHub / GitLab / Azure DevOps, commit les changements en attente,
        # applique la discard-list et refuse une PR vide. Appeler
        # `create_pull_request` (spécifique GitHub) à la main faisait échouer
        # la complétion sur les dépôts Azure DevOps.
        pr_title = self._build_pr_title(task_title)
        pr_body = self._build_pr_body(task_title, task_description)

        logger.info(
            f"[TaskCompletionService] Push + création de la PR vers {target}..."
        )
        pr_result = self.worktree_manager.push_and_create_pr(
            spec_name=spec_id,
            target_branch=target,
            title=pr_title,
            body=pr_body,
            draft=False,  # PR normale qui nécessite review
        )

        if not pr_result.get("success"):
            error_msg = pr_result.get("error", "Erreur inconnue")
            logger.error(f"[TaskCompletionService] Échec de la complétion: {error_msg}")
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

        # Announce on configured channels + emit hook event (no-op if not configured)
        if not pr_already_exists:
            _announce_pr_ready(
                PRReadyNotification(
                    task_title=task_title,
                    task_description=task_description,
                    pr_url=pr_url,
                    project_name=self.project_path.name,
                    branch=pr_result.get("branch"),
                    target_branch=target,
                    spec_id=spec_id,
                ),
                self.project_path,
            )

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
