"""
Coverage Enforcement Gate
=========================

Gate déterministe qui impose un seuil **minimum de couverture de tests** comme
pré-requis pour qu'une tâche (produite par les agents WorkPilot AI) soit
approuvée par la QA.

Principes :

- **Obligatoire** sur les tests **unitaires** et **d'intégration** (bloquant).
- **Best-effort** sur l'e2e (« si possible ») : un déficit e2e n'émet qu'un
  avertissement, il ne bloque pas le sign-off.
- **Langage-agnostique** : l'agent QA exécute l'outillage de couverture propre
  au projet (par service, via ``project_index.json``) puis enregistre les
  pourcentages dans ``qa_signoff.coverage`` de ``implementation_plan.json``. Ce
  gate ne fait que **valider les chiffres enregistrés**, il ne dépend d'aucun
  langage particulier.

Le seuil est piloté par la variable d'environnement
``WORKPILOT_QA_MIN_COVERAGE`` (défaut **100**), ce qui permet une activation
progressive :

- ``100`` → 100% obligatoire (défaut).
- ``1..99`` → palier transitoire.
- ``0`` → gate désactivé.

Le gate est conçu pour être branché dans ``qa/loop.py`` à la suite du
« Architecture Enforcement Gate », sur le même modèle : en cas d'échec, la tâche
repasse en ``rejected`` et la boucle fixer reprend jusqu'à atteindre le seuil.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypedDict

from .criteria import get_qa_signoff_status

# =============================================================================
# CONFIGURATION
# =============================================================================


def _read_min_coverage() -> int:
    """Lit ``WORKPILOT_QA_MIN_COVERAGE`` (défaut 100, borné à [0, 100])."""
    raw = os.environ.get("WORKPILOT_QA_MIN_COVERAGE")
    if not raw:
        return 100
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return 100
    return max(0, min(100, value))


# Évalué dynamiquement à chaque appel du gate pour rester testable et permettre
# l'activation progressive sans recharger le module.
def get_min_coverage() -> int:
    """Seuil de couverture minimal requis (en %)."""
    return _read_min_coverage()


def is_coverage_gate_enabled() -> bool:
    """Le gate est actif tant que le seuil est strictement positif."""
    return get_min_coverage() > 0


# Clés de tests obligatoires (bloquantes) vs best-effort.
REQUIRED_KEYS: tuple[str, ...] = ("unit", "integration")
BEST_EFFORT_KEYS: tuple[str, ...] = ("e2e",)


# =============================================================================
# PARSING
# =============================================================================


def parse_coverage_value(value: Any) -> float | None:
    """
    Normalise une valeur de couverture en pourcentage flottant.

    Accepte :
    - ``int`` / ``float`` (ex. ``100``, ``87.5``)
    - chaîne ``"100"``, ``"87.5%"``, ``"100 %"``
    - fraction ``"42/42"`` → 100.0 (lignes couvertes / lignes totales)

    Returns:
        Le pourcentage en ``float`` (0..100), ou ``None`` si non interprétable.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        pct = float(value)
        return pct if 0.0 <= pct <= 100.0 else None

    if isinstance(value, str):
        text = value.strip().replace("%", "").strip()
        if not text:
            return None
        # Fraction "covered/total"
        if "/" in text:
            covered_str, _, total_str = text.partition("/")
            try:
                covered = float(covered_str.strip())
                total = float(total_str.strip())
            except ValueError:
                return None
            if total <= 0:
                return None
            return max(0.0, min(100.0, covered / total * 100.0))
        try:
            pct = float(text)
        except ValueError:
            return None
        return pct if 0.0 <= pct <= 100.0 else None

    return None


def _extract_coverage_section(signoff: dict[str, Any] | None) -> dict[str, Any]:
    """
    Récupère la section de couverture du ``qa_signoff``.

    On tolère deux emplacements pour être robuste au formatage du modèle :
    - ``qa_signoff.coverage`` (emplacement recommandé)
    - ``qa_signoff.tests_passed.coverage`` (repli)
    """
    if not signoff:
        return {}
    coverage = signoff.get("coverage")
    if isinstance(coverage, dict):
        return coverage
    tests_passed = signoff.get("tests_passed")
    if isinstance(tests_passed, dict) and isinstance(
        tests_passed.get("coverage"), dict
    ):
        return tests_passed["coverage"]
    return {}


# =============================================================================
# RÉSULTAT
# =============================================================================


class CoverageGateReport(TypedDict):
    """Rapport structuré du gate de couverture."""

    passed: bool
    enabled: bool
    min_coverage: int
    measured: bool
    coverage: dict[str, float | None]
    failures: list[str]
    warnings: list[str]
    timestamp: str


def evaluate_coverage(
    coverage_section: dict[str, Any], min_coverage: int
) -> CoverageGateReport:
    """
    Évalue une section de couverture par rapport au seuil.

    Args:
        coverage_section: Dict ``{"unit": .., "integration": .., "e2e": ..}``.
        min_coverage: Seuil minimal (0..100).

    Returns:
        Un :class:`CoverageGateReport`.
    """
    failures: list[str] = []
    warnings: list[str] = []
    parsed: dict[str, float | None] = {}

    if min_coverage <= 0:
        return CoverageGateReport(
            passed=True,
            enabled=False,
            min_coverage=min_coverage,
            measured=False,
            coverage={},
            failures=[],
            warnings=[],
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    # Indicateur explicite « la couverture n'a pas pu être mesurée ».
    measured_flag = coverage_section.get("measured", None)
    explicitly_unmeasured = measured_flag is False

    any_value = False

    for key in REQUIRED_KEYS:
        pct = parse_coverage_value(coverage_section.get(key))
        parsed[key] = pct
        if pct is None:
            failures.append(
                f"Couverture '{key}' absente ou non mesurée — requis {min_coverage}%."
            )
        else:
            any_value = True
            if pct + 1e-9 < min_coverage:
                failures.append(
                    f"Couverture '{key}' {pct:.1f}% < {min_coverage}% requis."
                )

    for key in BEST_EFFORT_KEYS:
        pct = parse_coverage_value(coverage_section.get(key))
        parsed[key] = pct
        if pct is None:
            warnings.append(
                f"Couverture '{key}' non mesurée (best-effort, non bloquant)."
            )
        else:
            any_value = True
            if pct + 1e-9 < min_coverage:
                warnings.append(
                    f"Couverture '{key}' {pct:.1f}% < {min_coverage}% "
                    "(best-effort, non bloquant)."
                )

    if explicitly_unmeasured and not failures:
        failures.append(
            "Le sign-off QA indique que la couverture n'a pas été mesurée "
            f"(measured=false) — la mesure est obligatoire (seuil {min_coverage}%)."
        )

    measured = any_value and not explicitly_unmeasured

    return CoverageGateReport(
        passed=len(failures) == 0,
        enabled=True,
        min_coverage=min_coverage,
        measured=measured,
        coverage=parsed,
        failures=failures,
        warnings=warnings,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


def run_coverage_gate(spec_dir: Path) -> CoverageGateReport:
    """
    Exécute le gate de couverture pour un spec donné.

    Lit ``qa_signoff.coverage`` depuis ``implementation_plan.json`` et le
    compare au seuil courant.

    Returns:
        Un :class:`CoverageGateReport` (``passed=True`` si le gate est
        désactivé ou si le seuil est atteint).
    """
    min_coverage = get_min_coverage()
    signoff = get_qa_signoff_status(spec_dir)
    coverage_section = _extract_coverage_section(signoff)
    return evaluate_coverage(coverage_section, min_coverage)


# =============================================================================
# FIX REQUEST
# =============================================================================


def build_coverage_issues(report: CoverageGateReport) -> list[dict[str, Any]]:
    """Construit des issues exploitables par la boucle fixer / l'historique."""
    issues: list[dict[str, Any]] = []
    for failure in report["failures"]:
        issues.append(
            {
                "title": "Couverture de tests insuffisante",
                "description": failure,
                "type": "coverage_gap",
                "severity": "critical",
            }
        )
    return issues


def render_coverage_fix_request(report: CoverageGateReport) -> str:
    """Rend le contenu Markdown d'une demande de correctif de couverture."""
    min_cov = report["min_coverage"]
    lines: list[str] = [
        "# QA Fix Request — Couverture de tests",
        "",
        f"**Status**: REJECTED (coverage gate, seuil {min_cov}%)",
        f"**Date**: {report['timestamp']}",
        "",
        "## Problème",
        "",
        f"La couverture des tests **unitaires** et **d'intégration** doit "
        f"atteindre **{min_cov}%** (lignes et branches) pour que la tâche soit "
        "approuvée.",
        "",
        "## Détails",
        "",
    ]

    for key in (*REQUIRED_KEYS, *BEST_EFFORT_KEYS):
        pct = report["coverage"].get(key)
        shown = f"{pct:.1f}%" if isinstance(pct, (int, float)) else "non mesurée"
        tag = "(best-effort)" if key in BEST_EFFORT_KEYS else "(obligatoire)"
        lines.append(f"- **{key}** {tag} : {shown}")

    lines.append("")
    if report["failures"]:
        lines.append("## À corriger (bloquant)")
        lines.append("")
        for idx, failure in enumerate(report["failures"], start=1):
            lines.append(f"{idx}. {failure}")
        lines.append("")

    if report["warnings"]:
        lines.append("## Avertissements (non bloquant)")
        lines.append("")
        for warning in report["warnings"]:
            lines.append(f"- {warning}")
        lines.append("")

    lines.append("## Après correctifs")
    lines.append("")
    lines.append(
        "1. Ajouter/compléter les tests jusqu'à atteindre le seuil pour `unit` "
        "et `integration`."
    )
    lines.append(
        "2. Relancer les tests avec couverture et enregistrer les pourcentages "
        "dans `implementation_plan.json` → `qa_signoff.coverage`."
    )
    lines.append("3. Mettre `ready_for_qa_revalidation: true` pour relancer la QA.")
    lines.append("")
    return "\n".join(lines)


def write_coverage_fix_request(spec_dir: Path, report: CoverageGateReport) -> bool:
    """
    Écrit ``QA_FIX_REQUEST.md`` décrivant les déficits de couverture.

    Returns:
        ``True`` si le fichier a été écrit, ``False`` sinon.
    """
    fix_request_file = spec_dir / "QA_FIX_REQUEST.md"
    try:
        fix_request_file.write_text(
            render_coverage_fix_request(report), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def mark_signoff_rejected(spec_dir: Path, report: CoverageGateReport) -> bool:
    """
    Force ``qa_signoff.status = "rejected"`` dans ``implementation_plan.json``.

    Le QA reviewer a pu écrire ``status="approved"`` avant que ce gate
    déterministe ne détecte une couverture insuffisante. On rend le gate
    **autoritaire** en réécrivant le statut et en y attachant les déficits, afin
    que ``is_qa_approved()`` retourne ``False`` (et qu'un run ultérieur ne
    court-circuite pas la validation).

    Returns:
        ``True`` si le plan a été mis à jour, ``False`` sinon.
    """
    # Import local pour éviter tout cycle d'import au chargement du module.
    from .criteria import load_implementation_plan, save_implementation_plan

    plan = load_implementation_plan(spec_dir)
    if not plan:
        return False

    signoff = plan.get("qa_signoff")
    if not isinstance(signoff, dict):
        signoff = {}

    signoff["status"] = "rejected"
    signoff["ready_for_qa_revalidation"] = False
    signoff["coverage"] = {
        "measured": report["measured"],
        **{k: v for k, v in report["coverage"].items()},
    }

    issues = signoff.get("issues_found")
    if not isinstance(issues, list):
        issues = []
    # On retire d'éventuelles issues de couverture précédentes pour éviter les
    # doublons, puis on ré-ajoute les déficits courants.
    issues = [
        i
        for i in issues
        if not (isinstance(i, dict) and i.get("type") == "coverage_gap")
    ]
    issues.extend(build_coverage_issues(report))
    signoff["issues_found"] = issues
    signoff["timestamp"] = report["timestamp"]

    plan["qa_signoff"] = signoff
    return save_implementation_plan(spec_dir, plan)
