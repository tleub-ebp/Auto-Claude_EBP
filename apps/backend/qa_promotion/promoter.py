"""Compute a QA confidence score and decide whether to auto-promote."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

AUTO_PROMOTE_ENV_VAR = "WORKPILOT_AUTO_PROMOTE_THRESHOLD"

# Score breakdown — kept transparent so the audit trail can show *why*
# a build was promoted. Tweak here if telemetry shows the heuristic is
# wrong.
_BASE_SCORE_APPROVED = 80  # baseline when QA explicitly approved
_BONUS_NO_FRICTION = 10  # +10 if approved on the first QA pass
_BONUS_SELF_REVIEW = 5  # +5 if the coder wrote a self_review.md
_BONUS_TINY_REPORT = 5  # +5 if qa_report.md is short (= few issues)
_PENALTY_PER_EXTRA_SESSION = 5  # -5 per QA session beyond the first
_PENALTY_LARGE_REPORT = 10  # -10 if qa_report.md is suspiciously long


def auto_promote_threshold() -> int | None:
    """Return the configured threshold or None when the feature is off."""
    raw = (os.environ.get(AUTO_PROMOTE_ENV_VAR, "") or "").strip()
    if not raw:
        return None
    try:
        threshold = int(raw)
    except ValueError:
        logger.warning(
            "%s=%r is not an integer — feature stays off", AUTO_PROMOTE_ENV_VAR, raw
        )
        return None
    if not 0 <= threshold <= 100:
        logger.warning(
            "%s=%d is out of range [0, 100] — clamping", AUTO_PROMOTE_ENV_VAR, threshold
        )
        return max(0, min(100, threshold))
    return threshold


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


@dataclass
class PromotionDecision:
    """Outcome of the auto-promote check."""

    spec_id: str
    score: int  # 0-100
    threshold: int | None  # None when feature is off
    promote: bool  # True iff score >= threshold AND threshold is set
    reasons: list[str] = field(default_factory=list)
    breakdown: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "score": self.score,
            "threshold": self.threshold,
            "promote": self.promote,
            "reasons": list(self.reasons),
            "breakdown": dict(self.breakdown),
        }


def compute_qa_score(spec_dir: Path) -> tuple[int, dict[str, int], list[str]]:
    """Return (score, breakdown, reasons). Pure read of on-disk artefacts.

    Score is in [0, 100]. Reasons are human-readable strings explaining
    the contributions (positive or negative).
    """
    spec_dir = Path(spec_dir)
    breakdown: dict[str, int] = {}
    reasons: list[str] = []

    plan = _read_json(spec_dir / "implementation_plan.json")
    qa = (plan or {}).get("qa_signoff") or {}
    status = (qa.get("status") or "").lower()

    if status != "approved":
        breakdown["not_approved"] = -100
        reasons.append(f"QA verdict is {status!r} — no auto-promote possible")
        return 0, breakdown, reasons

    score = _BASE_SCORE_APPROVED
    breakdown["base_approved"] = _BASE_SCORE_APPROVED
    reasons.append(f"QA approved: +{_BASE_SCORE_APPROVED}")

    qa_session = int(qa.get("qa_session") or 1)
    if qa_session <= 1:
        score += _BONUS_NO_FRICTION
        breakdown["no_friction"] = _BONUS_NO_FRICTION
        reasons.append(f"approved on first QA pass: +{_BONUS_NO_FRICTION}")
    else:
        extra = max(0, qa_session - 1)
        penalty = extra * _PENALTY_PER_EXTRA_SESSION
        score -= penalty
        breakdown["session_friction"] = -penalty
        reasons.append(f"{qa_session} QA sessions: -{penalty}")

    if (spec_dir / "self_review.md").exists():
        score += _BONUS_SELF_REVIEW
        breakdown["self_review_present"] = _BONUS_SELF_REVIEW
        reasons.append(f"coder wrote self_review.md: +{_BONUS_SELF_REVIEW}")

    report_text = _read_text(spec_dir / "qa_report.md")
    report_chars = len(report_text)
    if 0 < report_chars <= 1500:
        score += _BONUS_TINY_REPORT
        breakdown["tiny_report"] = _BONUS_TINY_REPORT
        reasons.append(f"short qa_report.md ({report_chars}ch): +{_BONUS_TINY_REPORT}")
    elif report_chars > 8000:
        score -= _PENALTY_LARGE_REPORT
        breakdown["large_report"] = -_PENALTY_LARGE_REPORT
        reasons.append(
            f"long qa_report.md ({report_chars}ch — many issues?): "
            f"-{_PENALTY_LARGE_REPORT}"
        )

    score = max(0, min(100, score))
    return score, breakdown, reasons


def decide_promotion(spec_dir: Path) -> PromotionDecision:
    """Compute the score + apply the threshold. Never raises."""
    spec_dir = Path(spec_dir)
    spec_id = spec_dir.name
    threshold = auto_promote_threshold()

    score, breakdown, reasons = compute_qa_score(spec_dir)

    if threshold is None:
        return PromotionDecision(
            spec_id=spec_id,
            score=score,
            threshold=None,
            promote=False,
            reasons=[*reasons, f"feature disabled ({AUTO_PROMOTE_ENV_VAR} unset)"],
            breakdown=breakdown,
        )

    promote = score >= threshold
    if promote:
        reasons.append(f"score {score} ≥ threshold {threshold} → auto-promote")
    else:
        reasons.append(f"score {score} < threshold {threshold} → human review needed")

    return PromotionDecision(
        spec_id=spec_id,
        score=score,
        threshold=threshold,
        promote=promote,
        reasons=reasons,
        breakdown=breakdown,
    )
