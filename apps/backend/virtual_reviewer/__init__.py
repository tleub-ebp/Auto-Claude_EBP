"""Advisory virtual reviewer.

When the user enables it, the virtual reviewer reads the spec + diff +
QA report and writes a ``virtual_review.md`` file at the spec root with
a senior-reviewer-style commentary. The file:

  * Has a mandatory header that flags it as **machine-generated**.
  * Is never signed in the user's name.
  * Triggers no git operation, no PR, no comment posted anywhere.

The user reads it, decides what to do. The virtual reviewer is an
*input* to the human review process, not a substitute.

Configuration:
  * ``WORKPILOT_VIRTUAL_REVIEWER_ENABLED`` — opt-in. Default OFF.
"""

from .reviewer import (
    VIRTUAL_REVIEW_FILENAME,
    VIRTUAL_REVIEWER_ENV_VAR,
    VirtualReviewSummary,
    build_review_prompt,
    compute_review_summary,
    run_virtual_review,
    virtual_reviewer_enabled,
    write_virtual_review_stub,
)

__all__ = [
    "VIRTUAL_REVIEWER_ENV_VAR",
    "VIRTUAL_REVIEW_FILENAME",
    "VirtualReviewSummary",
    "build_review_prompt",
    "compute_review_summary",
    "run_virtual_review",
    "virtual_reviewer_enabled",
    "write_virtual_review_stub",
]
