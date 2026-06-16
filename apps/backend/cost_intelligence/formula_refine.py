"""AI refine — sharpen the success probability of the top formulas.

The heuristic :mod:`success_model` is free and instant but model-agnostic about
the *specific* task. This module runs a single, cheap LLM call (Haiku) that
looks at the actual task description and the handful of top-ranked candidate
formulas, then returns a task-aware success probability + a one-line reason for
each. This is the "hybrid" half of the estimator: heuristic by default, an
optional AI pass only on the 2-5 formulas the user actually cares about.

It is deliberately bounded:
  * one LLM call total (not one per formula),
  * Haiku by default (a few cents at most),
  * never raises — on any failure it returns an empty list and the UI keeps
    the heuristic numbers.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Structured-output schema the SDK validates + auto-retries against.
_OUTPUT_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "formula_assessments",
        "schema": {
            "type": "object",
            "properties": {
                "assessments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string"},
                            "success_probability": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 100,
                            },
                            "reason": {"type": "string"},
                        },
                        "required": ["key", "success_probability", "reason"],
                    },
                }
            },
            "required": ["assessments"],
        },
    },
}

_SYSTEM_PROMPT = (
    "You are an expert at predicting whether an autonomous coding agent will "
    "successfully ship a software task on the first attempt, given the model "
    "powering it and how much reasoning effort it is allowed.\n\n"
    "You will receive a task description and a short list of candidate "
    "'formulas' (provider + model + reasoning effort), each with a heuristic "
    "success estimate. For EACH formula, return a realistic success "
    "probability (0-100) for THIS specific task, and a concise one-sentence "
    "reason. Weigh the model's real-world coding ability, the task's "
    "difficulty, and whether the reasoning effort matches that difficulty. "
    "Reserve very high scores (>90) for strong models on clearly tractable "
    "tasks; be skeptical of weak/local models on hard tasks. Echo each "
    "formula's 'key' exactly."
)


@dataclass
class RefinedFormula:
    key: str
    success_probability: float  # 0-1
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "success_probability": round(self.success_probability, 4),
            "reason": self.reason,
        }


def _build_prompt(description: str, candidates: list[dict[str, Any]]) -> str:
    lines = [
        "Task description:",
        (description or "(no description provided)").strip(),
        "",
        "Candidate formulas (assess each one):",
    ]
    for c in candidates:
        heuristic = c.get("base_probability")
        heuristic_pct = (
            f"{round(float(heuristic) * 100)}%" if heuristic is not None else "n/a"
        )
        lines.append(
            f"- key={c['key']} | {c.get('provider')} {c.get('model')} "
            f"| effort={c.get('effort')} | tier={c.get('tier')} "
            f"| heuristic={heuristic_pct}"
        )
    lines.append("")
    lines.append(
        "Return an assessment for every key above. Keep reasons under 20 words."
    )
    return "\n".join(lines)


async def refine_formulas(
    description: str,
    candidates: list[dict[str, Any]],
    *,
    model: str = "claude-haiku-4-5-20251001",
) -> list[RefinedFormula]:
    """Run a single Haiku call to refine the candidate formulas. Never raises."""
    if not candidates:
        return []

    try:
        from core.simple_client import create_simple_client
    except Exception as exc:  # noqa: BLE001
        logger.warning("simple_client unavailable — skipping AI refine: %s", exc)
        return []

    prompt = _build_prompt(description, candidates)
    try:
        client = create_simple_client(
            agent_type="merge_resolver",  # text-only, no tools
            model=model,
            system_prompt=_SYSTEM_PROMPT,
            max_turns=1,
            output_format=_OUTPUT_FORMAT,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not create refine client: %s", exc)
        return []

    valid_keys = {c["key"] for c in candidates}
    try:
        async with client:
            await client.query(prompt)
            structured: Any = None
            text = ""
            async for msg in client.receive_response():
                name = type(msg).__name__
                if name == "ResultMessage":
                    structured = getattr(msg, "structured_output", None)
                elif name == "AssistantMessage" and hasattr(msg, "content"):
                    for block in msg.content:
                        if type(block).__name__ == "TextBlock" and hasattr(
                            block, "text"
                        ):
                            text += block.text
        payload = structured if structured else _loose_json(text)
        return _parse_assessments(payload, valid_keys)
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI refine call failed: %s", exc)
        return []


def _loose_json(text: str) -> dict[str, Any] | None:
    """Best-effort JSON extraction from a free-text reply."""
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def _parse_assessments(payload: Any, valid_keys: set[str]) -> list[RefinedFormula]:
    if not isinstance(payload, dict):
        return []
    items = payload.get("assessments")
    if not isinstance(items, list):
        return []
    out: list[RefinedFormula] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", ""))
        if key not in valid_keys:
            continue
        try:
            pct = float(item.get("success_probability"))
        except (TypeError, ValueError):
            continue
        prob = max(0.0, min(1.0, pct / 100.0))
        out.append(
            RefinedFormula(
                key=key,
                success_probability=prob,
                reason=str(item.get("reason", "")).strip(),
            )
        )
    return out


def refine_formulas_sync(
    description: str,
    candidates: list[dict[str, Any]],
    *,
    model: str = "claude-haiku-4-5-20251001",
) -> list[RefinedFormula]:
    """Synchronous wrapper around :func:`refine_formulas`."""
    try:
        return asyncio.run(refine_formulas(description, candidates, model=model))
    except RuntimeError:
        # Already inside an event loop — run in a fresh one on a thread.
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(
                lambda: asyncio.run(
                    refine_formulas(description, candidates, model=model)
                )
            ).result()
