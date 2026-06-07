"""
PR Impact Analyzer Agent
========================

Analyzes a PR diff and produces a French-language impact summary intended
to be appended to the PR description as a standardized block:

    ---
    <!-- workpilot-impact-block -->
    Note de l'impact (1 a 5) : 3
    Fonctionnalite(s) impactee(s) : Fiche vehicule, doc de vente

Rating scale (per user spec):
    1 = pas trop d'impact
    5 = enorme impact

This is intentionally provider-agnostic (GitHub / Azure DevOps / GitLab)
and does NOT depend on a .github/PULL_REQUEST_TEMPLATE.md being present.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_DIFF_CHARS = 30_000

IMPACT_BLOCK_MARKER = "<!-- workpilot-impact-block -->"
FALLBACK_RATING_LABEL = "N/A"
FALLBACK_FEATURES_LABEL = "Non evalue"


@dataclass(frozen=True)
class ImpactAnalysis:
    """Result of the impact analyzer agent."""

    rating: str  # "1".."5" or "N/A"
    features: str  # free-text French summary or "Non evalue"


def render_impact_block(analysis: ImpactAnalysis) -> str:
    """
    Render the standardized impact block to append to a PR description.

    Includes a marker comment so the block can be detected and updated
    later without duplication.
    """
    return (
        f"---\n"
        f"{IMPACT_BLOCK_MARKER}\n"
        f"Note de l'impact (1 à 5) : {analysis.rating}\n"
        f"Fonctionnalité(s) impactée(s) : {analysis.features}"
    )


def strip_existing_impact_block(body: str) -> str:
    """
    Remove a previously-injected impact block from a PR body, if present.

    Matches from the `---` separator that precedes the marker through the
    end of the body (the block is always last). Returns the body unchanged
    if no marker is found.
    """
    if IMPACT_BLOCK_MARKER not in body:
        return body
    # Find the separator that precedes the marker. We accept either the exact
    # pattern we emit ("---\n<marker>") or a tolerant variant where someone
    # has edited surrounding whitespace.
    pattern = re.compile(
        r"\n*-{3,}\s*\n\s*" + re.escape(IMPACT_BLOCK_MARKER) + r".*\Z",
        re.DOTALL,
    )
    return pattern.sub("", body).rstrip() + "\n"


def append_impact_block(body: str, analysis: ImpactAnalysis) -> str:
    """
    Append (or replace) the impact block at the end of a PR body.

    Idempotent: if an impact block is already present, it is stripped and
    re-appended with the new analysis.
    """
    cleaned = strip_existing_impact_block(body).rstrip()
    if cleaned:
        return f"{cleaned}\n\n{render_impact_block(analysis)}\n"
    return render_impact_block(analysis) + "\n"


def fallback_analysis() -> ImpactAnalysis:
    """Return the safe fallback when analysis fails or is unavailable."""
    return ImpactAnalysis(
        rating=FALLBACK_RATING_LABEL,
        features=FALLBACK_FEATURES_LABEL,
    )


def _truncate_diff(diff_summary: str) -> str:
    """Truncate large diffs to stay within token limits (same policy as pr_template_filler)."""
    if len(diff_summary) <= MAX_DIFF_CHARS:
        return diff_summary

    lines = diff_summary.splitlines()
    summary_lines: list[str] = [
        "(Diff truncated to file-level summaries due to size)",
        "",
    ]
    for line in lines:
        stripped = line.strip()
        if (
            stripped.startswith("diff --git")
            or stripped.startswith("---")
            or stripped.startswith("+++")
            or "file changed" in stripped.lower()
            or "files changed" in stripped.lower()
            or "insertion" in stripped.lower()
            or "deletion" in stripped.lower()
            or stripped.startswith("rename")
            or stripped.startswith("new file")
            or stripped.startswith("deleted file")
            or stripped.startswith("Binary files")
        ):
            summary_lines.append(line)

    if len(summary_lines) <= 2:
        return diff_summary[:MAX_DIFF_CHARS] + "\n\n(... diff truncated due to size)"
    return "\n".join(summary_lines)


def _build_prompt(diff_summary: str, spec_overview: str, commit_log: str) -> str:
    return f"""You are analyzing a pull request to produce a short IMPACT SUMMARY in FRENCH.

Return STRICT JSON with exactly two keys:
{{
  "rating": <integer 1..5>,
  "features": "<short French free-text>"
}}

No prose, no code fences, no preamble. Just the JSON object.

## Rating scale (1 to 5)
- 1 = pas trop d'impact (cosmetic, docs, gitignore, formatting, isolated comments)
- 2 = impact limite (small bugfix, internal refactor with tests, no API change)
- 3 = impact moyen (feature touching one business domain, schema tweak with migration, validation rules change)
- 4 = impact eleve (cross-module feature, breaking-ish change behind a flag, multiple business domains)
- 5 = enorme impact (architecture change, data migration without easy rollback, security/auth rewrite, cross-cutting refactor)

Be honest. Most PRs are 1-3. Reserve 4-5 for changes that genuinely require special attention from reviewers.

## Features field
Write a SHORT French summary listing the user-facing or domain-level features affected.
Use the same vocabulary the spec / commit messages use, in French.
Examples of good values:
- "Fiche vehicule, doc de vente"
- "Facturation electronique (validation TVA intracommunautaire), document de vente"
- "Aucune (hygiene repo)"
- "Authentification, gestion des sessions utilisateur"

Keep it under 250 characters. Comma-separated list. NO bullet points, NO newlines inside the value.

## Inputs

### Spec overview
{spec_overview}

### Commit log
```
{commit_log}
```

### Git diff
```
{diff_summary}
```

Output: just the JSON object."""


def _parse_response(response: str) -> ImpactAnalysis | None:
    """
    Parse the agent's JSON response into an ImpactAnalysis.

    Tolerant to: leading/trailing whitespace, markdown code fences, and
    a small amount of preamble/explanation that the model might emit
    despite instructions. Returns None on hard failure.
    """
    if not response:
        return None

    text = response.strip()

    # Strip markdown fences if present
    if text.startswith("```"):
        # remove ```json or ```
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1 :]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    # Try direct parse first
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Fallback: extract the first {...} block
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            logger.warning("Impact analyzer: no JSON object found in response")
            return None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as e:
            logger.warning(f"Impact analyzer: JSON parse failed: {e}")
            return None

    if not isinstance(data, dict):
        return None

    raw_rating = data.get("rating")
    raw_features = data.get("features")

    # Validate rating
    try:
        rating_int = int(raw_rating)
        if rating_int < 1 or rating_int > 5:
            logger.warning(f"Impact analyzer: rating out of range: {rating_int}")
            return None
        rating = str(rating_int)
    except (TypeError, ValueError):
        logger.warning(f"Impact analyzer: invalid rating value: {raw_rating!r}")
        return None

    # Validate features
    if not isinstance(raw_features, str) or not raw_features.strip():
        logger.warning("Impact analyzer: missing or empty features field")
        return None
    features = " ".join(raw_features.split())  # collapse whitespace/newlines
    if len(features) > 500:
        features = features[:497] + "..."

    return ImpactAnalysis(rating=rating, features=features)


def _load_spec_overview(spec_dir: Path) -> str:
    spec_file = spec_dir / "spec.md"
    if spec_file.is_file():
        try:
            content = spec_file.read_text(encoding="utf-8")
            if len(content) > 8000:
                return content[:8000] + "\n\n(... spec truncated for brevity)"
            return content
        except Exception as e:
            logger.warning(f"Failed to read spec.md: {e}")
    return "(No spec overview available)"


async def run_impact_analyzer(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    thinking_budget: int | None = None,
    diff_summary: str = "",
    commit_log: str = "",
    verbose: bool = False,
) -> ImpactAnalysis | None:
    """
    Run the impact analyzer agent.

    Returns None on any failure so the caller can fall back to the
    "N/A / Non evalue" block gracefully. Never raises.
    """
    if not diff_summary.strip():
        logger.info("Impact analyzer: empty diff, skipping")
        return None

    # Lazy imports so callers that only use the pure helpers (render_*,
    # append_*, strip_*, _parse_response, fallback_analysis) can import
    # this module in environments without the agent runtime stack.
    from core.client import create_agent_client
    from task_logger import LogPhase, get_task_logger

    from .session import run_agent_session

    spec_overview = (
        _load_spec_overview(spec_dir) if spec_dir else "(No spec overview available)"
    )
    prompt = _build_prompt(
        diff_summary=_truncate_diff(diff_summary),
        spec_overview=spec_overview,
        commit_log=commit_log,
    )

    task_logger = get_task_logger(spec_dir) if spec_dir else None
    if task_logger:
        task_logger.start_phase(LogPhase.CODING, "Impact analysis")

    client = create_agent_client(
        project_dir=project_dir,
        spec_dir=spec_dir,
        model=model,
        agent_type="impact_analyzer",
        max_thinking_tokens=thinking_budget,
    )

    try:
        async with client:
            status, response, _ = await run_agent_session(
                client, prompt, spec_dir, verbose, phase=LogPhase.CODING
            )

        if task_logger:
            task_logger.end_phase(
                LogPhase.CODING,
                success=(status != "error"),
                message="Impact analysis completed",
            )

        if status == "error" or not response:
            logger.warning("Impact analyzer: agent returned error or empty response")
            return None

        return _parse_response(response)

    except Exception as e:
        logger.warning(f"Impact analyzer error: {e}")
        if task_logger:
            task_logger.log_error(f"Impact analyzer error: {e}", LogPhase.CODING)
        return None


def run_impact_analyzer_sync(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    thinking_budget: int | None = None,
    diff_summary: str = "",
    commit_log: str = "",
    timeout_s: float = 30.0,
) -> ImpactAnalysis | None:
    """
    Synchronous wrapper around run_impact_analyzer with timeout.

    Handles the case where we're already inside a running event loop
    (mirror of the pattern used in worktree._try_ai_pr_body).
    """

    async def _with_timeout() -> ImpactAnalysis | None:
        try:
            return await asyncio.wait_for(
                run_impact_analyzer(
                    project_dir=project_dir,
                    spec_dir=spec_dir,
                    model=model,
                    thinking_budget=thinking_budget,
                    diff_summary=diff_summary,
                    commit_log=commit_log,
                    verbose=False,
                ),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            logger.warning(f"Impact analyzer timed out after {timeout_s}s")
            return None

    try:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(asyncio.run, _with_timeout())
                return future.result(timeout=timeout_s + 5.0)
        return asyncio.run(_with_timeout())
    except Exception as e:
        logger.warning(f"Impact analyzer sync wrapper failed: {e}")
        return None
