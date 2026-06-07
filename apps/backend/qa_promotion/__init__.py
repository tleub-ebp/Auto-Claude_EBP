"""Auto-promotion ai_review → human_review based on a QA score.

When a build leaves the QA loop with a high enough confidence score, the
Kanban can skip the human_review column and go straight to "ready for
PR / done". This is **opt-in** and **conservative by default** so we
never silently skip review on a borderline build.

Configuration:
  * ``WORKPILOT_AUTO_PROMOTE_THRESHOLD`` (int 0-100, default unset)
    When unset → feature OFF. Set to e.g. ``90`` to auto-promote
    builds with a QA score ≥ 90.

The score is computed from on-disk artefacts (no SDK call):
  * qa_signoff.status — "approved" required, else score = 0
  * qa_session count — 1 = clean, 2-3 = some friction, ≥4 = penalty
  * presence of self_review.md — small boost (coder explicitly handed off)
  * length of qa_report.md — heuristic on how many issues were noted

The score is **consultative**. The decision is recorded in the audit
trail as a ``decision_made`` event so a human can later audit which
builds got auto-promoted and why.
"""

from .promoter import (
    AUTO_PROMOTE_ENV_VAR,
    PromotionDecision,
    auto_promote_threshold,
    compute_qa_score,
    decide_promotion,
)

__all__ = [
    "AUTO_PROMOTE_ENV_VAR",
    "PromotionDecision",
    "auto_promote_threshold",
    "compute_qa_score",
    "decide_promotion",
]
