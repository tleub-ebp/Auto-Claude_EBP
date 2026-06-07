"""
Reusable Pydantic schemas for Claude Agent SDK structured outputs.

Pass `output_format=<schema>.as_output_format()` to `create_client()` or
`create_simple_client()` and the SDK will validate the model's JSON response,
retrying automatically up to its internal limit. This eliminates the manual
`json.loads` + fallback parsing that scatters across utility runners.

Why share schemas here:
- One place to evolve the contract; runners just import what they need.
- Failures surface as `ResultMessage.subtype == "error_max_structured_output_retries"`
  instead of a silent malformed-JSON parse downstream.
- Each schema bundles the wire-format helper so callers don't have to know
  the `{"type": "json_schema", "schema": ...}` envelope.

See: https://code.claude.com/docs/en/agent-sdk/structured-outputs
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


def _as_output_format(model_cls: type[BaseModel]) -> dict[str, Any]:
    """Wrap a Pydantic model's JSON Schema in the SDK's output_format envelope."""
    return {"type": "json_schema", "schema": model_cls.model_json_schema()}


# ---------------------------------------------------------------------------
# Commit message — used by apps/backend/commit_message.py
# ---------------------------------------------------------------------------


class CommitMessage(BaseModel):
    """A Conventional-Commits-style commit message split into its parts."""

    type: Literal[
        "feat",
        "fix",
        "refactor",
        "docs",
        "test",
        "chore",
        "perf",
        "ci",
        "build",
        "style",
    ] = Field(description="Conventional commit type prefix")
    scope: str | None = Field(
        default=None,
        description="Optional scope, e.g. 'auth', 'kanban', without parentheses",
    )
    subject: str = Field(
        description="Short imperative subject line (no trailing period, max 72 chars)",
        max_length=72,
    )
    body: str | None = Field(
        default=None,
        description="Optional body explaining the why; wrap at 72 chars",
    )

    @classmethod
    def as_output_format(cls) -> dict[str, Any]:
        return _as_output_format(cls)

    def render(self) -> str:
        """Render to a single string in Conventional Commits format."""
        header = f"{self.type}"
        if self.scope:
            header += f"({self.scope})"
        header += f": {self.subject}"
        return f"{header}\n\n{self.body}" if self.body else header


# ---------------------------------------------------------------------------
# Merge conflict resolution — used by merge_resolver utility agent
# ---------------------------------------------------------------------------


class MergeResolution(BaseModel):
    """Decision for a single merge conflict hunk."""

    take_ours: bool = Field(description="True if 'ours' wins, false if 'theirs' wins")
    reason: str = Field(description="One-sentence justification")
    needs_human_review: bool = Field(
        default=False,
        description="True when the conflict is too ambiguous to resolve mechanically",
    )

    @classmethod
    def as_output_format(cls) -> dict[str, Any]:
        return _as_output_format(cls)


# ---------------------------------------------------------------------------
# PR template fill-in — used by agents/pr_template_filler.py
# ---------------------------------------------------------------------------


class PullRequestTemplate(BaseModel):
    """Filled-in pull request template ready to render to markdown."""

    title: str = Field(description="Pull request title (concise, imperative)")
    summary: list[str] = Field(
        description="Bullet points summarising what changed and why",
        min_length=1,
    )
    test_plan: list[str] = Field(
        description="Bullet points describing how the change was tested",
        min_length=1,
    )
    breaking_changes: list[str] = Field(
        default_factory=list,
        description="Empty array if none",
    )

    @classmethod
    def as_output_format(cls) -> dict[str, Any]:
        return _as_output_format(cls)


# ---------------------------------------------------------------------------
# Insight extraction — used by analysis/insight_extractor.py
# ---------------------------------------------------------------------------


class FileInsight(BaseModel):
    """A single learning attached to a specific file."""

    file_path: str
    insight: str = Field(description="What was learned about this file")
    category: Literal["pattern", "gotcha", "constraint", "convention"] = "pattern"


class ExtractedInsights(BaseModel):
    """Structured output for the post-session insight extractor."""

    file_insights: list[FileInsight] = Field(default_factory=list)
    patterns_discovered: list[str] = Field(
        default_factory=list,
        description="Cross-file patterns worth remembering",
    )
    gotchas: list[str] = Field(
        default_factory=list,
        description="Pitfalls, edge cases, surprising behaviour to remember",
    )
    summary: str = Field(description="One-paragraph summary of the session")

    @classmethod
    def as_output_format(cls) -> dict[str, Any]:
        return _as_output_format(cls)


__all__ = [
    "CommitMessage",
    "MergeResolution",
    "PullRequestTemplate",
    "FileInsight",
    "ExtractedInsights",
]
