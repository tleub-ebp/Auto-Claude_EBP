"""Scaffold + compare local-Arena variations of a spec."""

from __future__ import annotations

import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PARALLEL_VARIATIONS_ENV_VAR = "WORKPILOT_PARALLEL_VARIATIONS"

# Hard cap, regardless of env var. Beyond 5 variations the UX collapses
# (you can't realistically compare more than that side-by-side) and the
# disk + token cost balloons.
_HARD_MAX = 5
DEFAULT_MAX_VARIATIONS = 1

# Files we copy from the spec into each variation folder. The variation
# inherits the spec text but gets its own implementation_plan + worktree
# state.
_INHERITED_FILES = (
    "spec.md",
    "requirements.json",
    "context.json",
)


def parallel_variations_limit() -> int:
    raw = (os.environ.get(PARALLEL_VARIATIONS_ENV_VAR, "") or "").strip()
    if not raw:
        return DEFAULT_MAX_VARIATIONS
    try:
        n = int(raw)
    except ValueError:
        logger.warning(
            "%s=%r not an integer — using default %d",
            PARALLEL_VARIATIONS_ENV_VAR,
            raw,
            DEFAULT_MAX_VARIATIONS,
        )
        return DEFAULT_MAX_VARIATIONS
    return max(1, min(_HARD_MAX, n))


@dataclass
class VariationDescriptor:
    label: str  # "v1", "v2", … unique within the parent spec
    path: Path
    spec_id: str  # parent spec id
    seed: int  # for reproducibility / random sampling

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "path": str(self.path),
            "spec_id": self.spec_id,
            "seed": self.seed,
        }


@dataclass
class VariationManifest:
    """List of variations scaffolded for a parent spec."""

    spec_id: str
    parent_path: str
    variations: list[VariationDescriptor] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "parent_path": self.parent_path,
            "variations": [v.to_dict() for v in self.variations],
        }


def _variations_dir(spec_dir: Path) -> Path:
    return Path(spec_dir) / "variations"


def list_variations(spec_dir: Path) -> VariationManifest:
    """Return what's already scaffolded under ``<spec>/variations/``."""
    spec_dir = Path(spec_dir)
    base = _variations_dir(spec_dir)
    manifest = VariationManifest(spec_id=spec_dir.name, parent_path=str(spec_dir))
    if not base.is_dir():
        return manifest

    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        seed = 0
        meta = entry / ".variation.json"
        if meta.exists():
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
                seed = int(data.get("seed", 0))
            except (OSError, json.JSONDecodeError, ValueError):
                pass
        manifest.variations.append(
            VariationDescriptor(
                label=entry.name,
                path=entry,
                spec_id=spec_dir.name,
                seed=seed,
            )
        )
    return manifest


def create_variations(spec_dir: Path, count: int) -> VariationManifest:
    """Scaffold ``count`` variations of the spec.

    Existing variations are preserved — we only create the missing ones.
    Raises ``ValueError`` for invalid count (≤ 0 or above the env cap).
    """
    spec_dir = Path(spec_dir)
    if not spec_dir.is_dir():
        raise ValueError(f"spec_dir does not exist: {spec_dir}")

    cap = parallel_variations_limit()
    if count < 1:
        raise ValueError(f"count must be ≥ 1 (got {count})")
    if count > cap:
        raise ValueError(
            f"count {count} exceeds {PARALLEL_VARIATIONS_ENV_VAR}={cap} "
            f"(hard cap = {_HARD_MAX}). Lower the request or raise the cap."
        )

    base = _variations_dir(spec_dir)
    base.mkdir(exist_ok=True)

    # Existing labels keep their slot; fill the gaps up to `count`.
    existing = {v.label for v in list_variations(spec_dir).variations}
    descriptors: list[VariationDescriptor] = []
    target_labels = [f"v{i}" for i in range(1, count + 1)]
    for idx, label in enumerate(target_labels, start=1):
        target = base / label
        seed = idx * 7919  # arbitrary deterministic seed per slot
        if label not in existing:
            target.mkdir(parents=True, exist_ok=False)
            for name in _INHERITED_FILES:
                src = spec_dir / name
                if src.exists():
                    shutil.copy2(src, target / name)
            (target / ".variation.json").write_text(
                json.dumps(
                    {
                        "spec_id": spec_dir.name,
                        "label": label,
                        "seed": seed,
                        "inherited": list(_INHERITED_FILES),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        descriptors.append(
            VariationDescriptor(
                label=label, path=target, spec_id=spec_dir.name, seed=seed
            )
        )

    return VariationManifest(
        spec_id=spec_dir.name,
        parent_path=str(spec_dir),
        variations=descriptors,
    )


@dataclass
class VariationComparison:
    """Side-by-side stats so the user can pick a winner.

    The "winner" suggestion is purely heuristic — small diff + completed
    plan + smaller QA report wins. Always advisory; final pick is the
    user's.
    """

    spec_id: str
    rows: list[dict[str, Any]] = field(default_factory=list)
    suggested_winner: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "rows": list(self.rows),
            "suggested_winner": self.suggested_winner,
        }


def _stat_for(variation_path: Path) -> dict[str, Any]:
    """Cheap, file-system-only signals about how a variation went."""
    plan_path = variation_path / "implementation_plan.json"
    qa_report = variation_path / "qa_report.md"
    self_review = variation_path / "self_review.md"

    completed = 0
    total = 0
    qa_status = "unknown"
    if plan_path.exists():
        try:
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            for phase in plan.get("phases", []) or []:
                for st in phase.get("subtasks", []) or []:
                    total += 1
                    if (st.get("status") or "").lower() == "completed":
                        completed += 1
            qa_status = (
                (plan.get("qa_signoff") or {}).get("status") or "unknown"
            ).lower()
        except (OSError, json.JSONDecodeError):
            pass

    qa_report_chars = 0
    if qa_report.exists():
        try:
            qa_report_chars = len(qa_report.read_text(encoding="utf-8"))
        except OSError:
            pass

    return {
        "subtasks_completed": completed,
        "subtasks_total": total,
        "qa_status": qa_status,
        "qa_report_chars": qa_report_chars,
        "has_self_review": self_review.exists(),
    }


def _suggest_winner(rows: list[dict[str, Any]]) -> str | None:
    """Return the label of the suggested winner (or None if no clear one).

    Heuristic priority:
      1. only one variation has qa_status="approved" → that one wins
      2. otherwise, highest completion ratio
      3. tiebreaker: shortest qa_report.md (less issues to triage)
    """
    if not rows:
        return None

    approved = [r for r in rows if r["qa_status"] == "approved"]
    if len(approved) == 1:
        return approved[0]["label"]

    candidates = approved if approved else rows

    def _score(r: dict[str, Any]) -> tuple[float, int]:
        ratio = (
            r["subtasks_completed"] / r["subtasks_total"]
            if r["subtasks_total"]
            else 0.0
        )
        # Negative report length so shorter (= fewer issues) sorts higher.
        return (ratio, -r["qa_report_chars"])

    sorted_rows = sorted(candidates, key=_score, reverse=True)
    if not sorted_rows:
        return None
    # Only suggest a winner when it strictly beats the runner-up.
    if len(sorted_rows) >= 2 and _score(sorted_rows[0]) == _score(sorted_rows[1]):
        return None
    return sorted_rows[0]["label"]


def compare_variations(spec_dir: Path) -> VariationComparison:
    """Build a comparison table for all variations under the spec."""
    spec_dir = Path(spec_dir)
    manifest = list_variations(spec_dir)
    rows: list[dict[str, Any]] = []
    for variation in manifest.variations:
        row = {"label": variation.label, **_stat_for(variation.path)}
        rows.append(row)
    return VariationComparison(
        spec_id=spec_dir.name,
        rows=rows,
        suggested_winner=_suggest_winner(rows),
    )
