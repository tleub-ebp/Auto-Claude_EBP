"""Build + write a virtual code-review note. Advisory only."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

VIRTUAL_REVIEWER_ENV_VAR = "WORKPILOT_VIRTUAL_REVIEWER_ENABLED"
VIRTUAL_REVIEW_FILENAME = "virtual_review.md"

# This banner MUST start every virtual_review.md to make it impossible to
# mistake the file for a real human review (e.g. when copy-pasted into a PR).
_BANNER = (
    "<!-- AUTO-GENERATED VIRTUAL REVIEW — NOT A HUMAN APPROVAL -->\n\n"
    "> ⚠ **Machine-generated advisory review.**\n"
    "> This document was produced by the Virtual Reviewer agent. It is\n"
    "> *not* a human approval, *not* signed in anyone's name, and *not*\n"
    "> a substitute for a real review. Read it as a starting point.\n"
)


def virtual_reviewer_enabled() -> bool:
    return (os.environ.get(VIRTUAL_REVIEWER_ENV_VAR, "") or "").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


@dataclass
class VirtualReviewSummary:
    """Inputs the virtual reviewer assembled from on-disk artefacts."""

    spec_id: str
    spec_chars: int
    qa_report_chars: int
    self_review_present: bool
    diff_excerpt: str = ""
    diff_truncated: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec_id": self.spec_id,
            "spec_chars": self.spec_chars,
            "qa_report_chars": self.qa_report_chars,
            "self_review_present": self.self_review_present,
            "diff_excerpt": self.diff_excerpt,
            "diff_truncated": self.diff_truncated,
            "error": self.error,
        }


_MAX_DIFF_CHARS = 24_000


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def compute_review_summary(spec_dir: Path, project_dir: Path) -> VirtualReviewSummary:
    """Gather the inputs the virtual reviewer needs. Never raises."""
    spec_dir = Path(spec_dir)
    project_dir = Path(project_dir)

    spec_text = _read_text(spec_dir / "spec.md")
    qa_report = _read_text(spec_dir / "qa_report.md")
    self_review = (spec_dir / "self_review.md").exists()

    # Reuse self_review's diff helper rather than re-implementing.
    try:
        from agents.self_review import compute_diff_summary

        diff_summary = compute_diff_summary(spec_dir, project_dir)
        diff_excerpt = diff_summary.diff_excerpt[:_MAX_DIFF_CHARS]
        truncated = (
            diff_summary.truncated or len(diff_summary.diff_excerpt) > _MAX_DIFF_CHARS
        )
        if truncated and not diff_excerpt.endswith("[truncated]…\n"):
            diff_excerpt += "\n…[truncated by virtual_reviewer cap]…\n"
        return VirtualReviewSummary(
            spec_id=spec_dir.name,
            spec_chars=len(spec_text),
            qa_report_chars=len(qa_report),
            self_review_present=self_review,
            diff_excerpt=diff_excerpt,
            diff_truncated=truncated,
            error=diff_summary.error,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("virtual_reviewer: diff summary failed: %s", exc)
        return VirtualReviewSummary(
            spec_id=spec_dir.name,
            spec_chars=len(spec_text),
            qa_report_chars=len(qa_report),
            self_review_present=self_review,
            error=str(exc),
        )


def build_review_prompt(summary: VirtualReviewSummary) -> str:
    """The user prompt sent to the SDK for the virtual reviewer pass."""
    diff_block = summary.diff_excerpt or "(no diff captured — git was unavailable)"
    self_review_note = (
        " The coder also produced `self_review.md` — read it before this diff."
        if summary.self_review_present
        else ""
    )
    return (
        f"You are a senior code reviewer doing a *consultative* review of "
        f"spec `{summary.spec_id}`. Your output will be saved as "
        f"`{VIRTUAL_REVIEW_FILENAME}` and shown to a human reviewer as a "
        f"starting point.{self_review_note}\n\n"
        f"Stats: spec is {summary.spec_chars} chars, QA report is "
        f"{summary.qa_report_chars} chars.\n\n"
        f"Diff (truncated to {_MAX_DIFF_CHARS} chars):\n"
        f"```diff\n{diff_block}\n```\n\n"
        f"Write the review with EXACTLY these sections, no preamble, no "
        f"signature, no claim of identity:\n\n"
        f"## Summary\n(2-3 sentences: what the change does, in your words.)\n\n"
        f"## Strengths\n(bullet — what's well done. Empty if nothing stands out.)\n\n"
        f"## Concerns\n(bullet — risks, smells, missing edge cases. Be SPECIFIC: "
        f"file:line where possible.)\n\n"
        f"## Suggested patch\n(small diff or pseudo-code if you can; otherwise "
        f"a precise actionable description.)\n\n"
        f"## Approve?\nOne of: ✅ approve / ⚠ approve with comments / ❌ request changes.\n"
    )


def write_virtual_review_stub(spec_dir: Path, summary: VirtualReviewSummary) -> Path:
    """Deterministic fallback when no SDK is available.

    Writes a minimal `virtual_review.md` so the human still sees the
    advisory banner (= no false sense of "no review needed") plus the
    raw diff stats.
    """
    spec_dir = Path(spec_dir)
    spec_dir.mkdir(parents=True, exist_ok=True)
    target = spec_dir / VIRTUAL_REVIEW_FILENAME
    body = (
        f"{_BANNER}\n"
        f"# Virtual review (deterministic stub)\n\n"
        f"_The SDK was unavailable. This is the deterministic fallback:_\n"
        f"_diff stats only, no curated commentary._\n\n"
        f"## Summary\n"
        f"_(no model output — please review the diff manually.)_\n\n"
        f"## Strengths\n_(unknown)_\n\n"
        f"## Concerns\n"
        f"- spec is {summary.spec_chars} chars\n"
        f"- qa_report.md is {summary.qa_report_chars} chars\n"
        f"- coder self_review.md present: {summary.self_review_present}\n"
    )
    if summary.error:
        body += f"\n_diff capture error: {summary.error}_\n"
    target.write_text(body, encoding="utf-8")
    return target


class _Invokable(Protocol):
    async def invoke(self, prompt: str) -> str: ...  # pragma: no cover


async def run_virtual_review(
    client: _Invokable | None,
    spec_dir: Path,
    project_dir: Path,
) -> Path | None:
    """Produce ``virtual_review.md``. Returns the path or None on failure.

    Best-effort. Falls back to the deterministic stub on any error.
    """
    spec_dir = Path(spec_dir)
    project_dir = Path(project_dir)
    summary = compute_review_summary(spec_dir, project_dir)

    if client is None:
        return write_virtual_review_stub(spec_dir, summary)

    prompt = build_review_prompt(summary)
    try:
        response = await client.invoke(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("virtual_reviewer SDK call failed: %s — writing stub", exc)
        return write_virtual_review_stub(spec_dir, summary)

    # Always prepend the banner so the file is unambiguously machine-generated,
    # even if the model decides to add its own intro.
    body = response.lstrip()
    if body.startswith(_BANNER.strip()):
        # Model already echoed the banner (rare); keep one copy.
        final = body
    else:
        final = f"{_BANNER}\n{body}"

    target = spec_dir / VIRTUAL_REVIEW_FILENAME
    try:
        target.write_text(final, encoding="utf-8")
        return target
    except OSError as exc:
        logger.warning("virtual_reviewer write failed: %s", exc)
        return None
