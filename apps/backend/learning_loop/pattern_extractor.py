"""
Pattern Extractor for the Autonomous Agent Learning Loop.

Uses Claude Agent SDK to analyze completed build data and extract
actionable success/failure patterns.
"""

import json
import logging
from pathlib import Path
from typing import Any

from .models import LearningPattern, PatternCategory, PatternSource, PatternType

logger = logging.getLogger(__name__)


class PatternExtractor:
    """Extracts learning patterns from completed build data using AI analysis."""

    def __init__(
        self,
        project_dir: Path,
        model: str | None = None,
        thinking_level: str | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.specs_dir = self.project_dir / ".workpilot" / "specs"
        self.model = model or "sonnet"
        self.thinking_level = thinking_level or "medium"

    def gather_build_data(self, spec_dir: Path) -> dict[str, Any]:
        """Gather all relevant data from a completed build's spec directory."""
        data: dict[str, Any] = {"spec_id": spec_dir.name}

        # Read implementation plan
        plan_file = spec_dir / "implementation_plan.json"
        if plan_file.exists():
            try:
                plan = json.loads(plan_file.read_text(encoding="utf-8"))
                data["implementation_plan"] = {
                    "feature": plan.get("feature", ""),
                    "workflow_type": plan.get("workflow_type", ""),
                    "status": plan.get("status", ""),
                    "qa_signoff": plan.get("qa_signoff", {}),
                    "qa_iteration_history": plan.get("qa_iteration_history", []),
                    "qa_stats": plan.get("qa_stats", {}),
                    "phases_count": len(plan.get("phases", [])),
                    "subtasks_count": sum(
                        len(phase.get("subtasks", []))
                        for phase in plan.get("phases", [])
                    ),
                }
            except Exception as e:
                logger.warning(f"Failed to read implementation plan: {e}")

        # Read QA report
        qa_report_file = spec_dir / "qa_report.md"
        if qa_report_file.exists():
            try:
                content = qa_report_file.read_text(encoding="utf-8")
                # Truncate to avoid exceeding token limits
                data["qa_report"] = content[:3000]
            except Exception as e:
                logger.warning(f"Failed to read QA report: {e}")

        # Read spec (truncated)
        spec_file = spec_dir / "spec.md"
        if spec_file.exists():
            try:
                content = spec_file.read_text(encoding="utf-8")
                data["spec_summary"] = content[:1500]
            except Exception as e:
                logger.warning(f"Failed to read spec: {e}")

        # Read context tags from context.json
        context_file = spec_dir / "context.json"
        if context_file.exists():
            try:
                ctx = json.loads(context_file.read_text(encoding="utf-8"))
                data["context_tags"] = ctx.get("tags", [])
                data["languages"] = ctx.get("languages", [])
                data["frameworks"] = ctx.get("frameworks", [])
            except Exception:
                pass

        # Check for escalation or manual test plan
        data["had_escalation"] = (spec_dir / "QA_ESCALATION.md").exists()
        data["had_manual_test_plan"] = (spec_dir / "MANUAL_TEST_PLAN.md").exists()

        # CI/CD failure report (written by the pipeline watcher on red builds)
        build_failure_file = spec_dir / "BUILD_FAILURE.md"
        if build_failure_file.exists():
            try:
                data["build_failure"] = build_failure_file.read_text(encoding="utf-8")[
                    :3000
                ]
            except Exception as e:
                logger.warning(f"Failed to read BUILD_FAILURE.md: {e}")

        # Task outcome (human verdict from review, or recorded CI failure)
        outcome_file = spec_dir / "task_outcome.json"
        if outcome_file.exists():
            try:
                outcome = json.loads(outcome_file.read_text(encoding="utf-8"))
                data["task_outcome"] = {
                    "verdict": outcome.get("verdict", ""),
                    "details": outcome.get("details", ""),
                    "history": [
                        {
                            "verdict": entry.get("verdict", ""),
                            "details": (entry.get("details") or "")[:300],
                        }
                        for entry in outcome.get("history", [])[-5:]
                    ],
                }
            except Exception as e:
                logger.warning(f"Failed to read task_outcome.json: {e}")

        return data

    def gather_all_builds_data(self, limit: int = 20) -> list[dict[str, Any]]:
        """Gather data from all completed builds in the project."""
        builds = []
        if not self.specs_dir.exists():
            return builds

        spec_dirs = sorted(self.specs_dir.iterdir(), reverse=True)
        for spec_dir in spec_dirs[:limit]:
            if not spec_dir.is_dir():
                continue
            plan_file = spec_dir / "implementation_plan.json"
            if not plan_file.exists():
                continue
            try:
                build_data = self.gather_build_data(spec_dir)
                builds.append(build_data)
            except Exception as e:
                logger.warning(f"Failed to gather data for {spec_dir.name}: {e}")
        return builds

    def build_analysis_prompt(self, builds_data: list[dict[str, Any]]) -> str:
        """Construct the analysis prompt for the meta-agent."""
        prompt_template = self._load_prompt_template()

        builds_json = json.dumps(builds_data, indent=2, default=str, ensure_ascii=False)
        # Truncate if too long
        if len(builds_json) > 30000:
            builds_json = builds_json[:30000] + "\n... (truncated)"

        return f"{prompt_template}\n\n## Build Data to Analyze\n\n```json\n{builds_json}\n```"

    def parse_patterns_from_response(
        self, response: str, builds_data: list[dict[str, Any]]
    ) -> list[LearningPattern]:
        """Parse LearningPattern objects from the agent's response."""
        patterns = []

        # Extract JSON array from response
        json_str = self._extract_json_array(response)
        if not json_str:
            logger.warning("No JSON array found in analysis response")
            return patterns

        try:
            raw_patterns = json.loads(json_str)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse patterns JSON: {e}")
            return patterns

        # Collect all spec IDs as source build IDs
        source_ids = [b.get("spec_id", "") for b in builds_data if b.get("spec_id")]
        # Collect context tags
        all_tags: set[str] = set()
        for b in builds_data:
            all_tags.update(b.get("context_tags", []))
            all_tags.update(b.get("languages", []))
            all_tags.update(b.get("frameworks", []))

        for raw in raw_patterns:
            try:
                pattern = LearningPattern(
                    pattern_id=LearningPattern.generate_id(),
                    category=PatternCategory(raw.get("category", "code_structure")),
                    pattern_type=PatternType(raw.get("pattern_type", "optimization")),
                    source=PatternSource.BUILD_ANALYSIS,
                    description=raw.get("description", ""),
                    confidence=float(raw.get("confidence", 0.5)),
                    occurrence_count=int(raw.get("occurrence_count", 1)),
                    agent_phase=raw.get("agent_phase", "coding"),
                    context_tags=raw.get("context_tags", list(all_tags)[:10]),
                    actionable_instruction=raw.get("actionable_instruction", ""),
                    source_build_ids=source_ids,
                )
                if pattern.actionable_instruction:
                    patterns.append(pattern)
            except Exception as e:
                logger.warning(f"Failed to parse pattern: {e}")

        return patterns

    def _load_prompt_template(self) -> str:
        """Load the learning analyzer prompt template."""
        prompt_path = Path(__file__).parent.parent / "prompts" / "learning_analyzer.md"
        if prompt_path.exists():
            return prompt_path.read_text(encoding="utf-8")
        # Fallback inline prompt
        return self._default_prompt()

    def _default_prompt(self) -> str:
        return """# Learning Pattern Analyzer

You are a meta-analysis agent that examines completed software build sessions
to extract actionable patterns for improving future builds.

## Your Task

Analyze the provided build data and extract patterns in these categories:
- tool_sequence: Effective or ineffective sequences of tool usage
- prompt_strategy: Approaches that led to better/worse outcomes
- error_resolution: Common errors and their resolution strategies
- qa_pattern: Patterns related to QA pass/fail rates
- code_structure: Code organization patterns that affect build success

## Output Format

Output ONLY a JSON array of pattern objects with these fields:
- category: One of tool_sequence, prompt_strategy, error_resolution, qa_pattern, code_structure
- pattern_type: One of success, failure, optimization
- description: Brief description of the pattern
- confidence: 0.0-1.0 based on how many builds support this pattern
- occurrence_count: How many builds exhibited this pattern
- agent_phase: One of planning, coding, qa_review, qa_fixing
- context_tags: List of relevant technology tags
- actionable_instruction: A clear, specific instruction for future agents

## Guidelines
- Focus on ACTIONABLE insights, not obvious observations
- High confidence (>0.7) for patterns seen in 3+ builds
- Medium confidence (0.5-0.7) for patterns seen in 2 builds
- Low confidence (<0.5) for single-occurrence patterns
- Each instruction must be specific enough to guide an agent
- Limit to 15 most impactful patterns"""

    def _extract_json_array(self, text: str) -> str | None:
        """Extract a JSON array from text, handling markdown code blocks."""
        # Try to find JSON in code blocks
        import re

        patterns = [
            r"```json\s*\n(.*?)\n\s*```",
            r"```\s*\n(.*?)\n\s*```",
            r"(\[[\s\S]*\])",
        ]
        for pattern in patterns:
            match = re.search(pattern, text, re.DOTALL)
            if match:
                candidate = match.group(1).strip()
                if candidate.startswith("["):
                    return candidate
        return None
