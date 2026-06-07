"""Generate a spec file from a high-ROI debt item."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from tech_debt.scanner import DebtItem


def generate_spec_from_item(
    project_path: str | Path,
    item: DebtItem,
    llm_hint: str | None = None,
) -> Path:
    """
    Create a spec directory with spec.md describing the debt item.

    LLM enrichment is optional: if llm_hint is provided it is inlined as
    a suggestion block. The caller is expected to pass a response from any
    provider (Claude, OpenAI, Copilot, Windsurf, Ollama, …).
    """
    root = Path(project_path).resolve()
    specs_root = root / ".workpilot" / "specs"
    specs_root.mkdir(parents=True, exist_ok=True)

    existing = [p for p in specs_root.iterdir() if p.is_dir()]
    next_id = f"{len(existing) + 1:03d}"
    slug = _slugify(item.message)[:40]
    spec_dir = specs_root / f"{next_id}-tech-debt-{slug}"
    spec_dir.mkdir(parents=True, exist_ok=True)

    spec_md = spec_dir / "spec.md"
    body = _render_spec(item, llm_hint)
    spec_md.write_text(body, encoding="utf-8")

    meta = spec_dir / "source.json"
    meta.write_text(json.dumps(item.to_dict(), indent=2), encoding="utf-8")
    return spec_dir


def _slugify(text: str) -> str:
    out = []
    for ch in text.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_"):
            out.append("-")
    return "".join(out).strip("-") or "item"


def _render_spec(item: DebtItem, llm_hint: str | None) -> str:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [
        f"# Tech Debt: {item.message}",
        "",
        f"*Generated from `{item.file_path}:{item.line}` on {now} UTC*",
        "",
        "## Source signal",
        "",
        f"- Kind: **{item.kind}**",
        f"- Cost (per week if kept): **{item.cost}**",
        f"- Effort to fix (hours): **{item.effort}**",
        f"- ROI: **{item.roi}**",
        f"- Tags: {', '.join(item.tags) or '—'}",
        "",
    ]
    if item.context:
        lines += ["## Context", "", "```", item.context, "```", ""]
    lines += [
        "## Objective",
        "",
        f"Resolve the tech debt item detected in `{item.file_path}` at line {item.line}.",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] The identified issue no longer appears in the next tech debt scan.",
        "- [ ] Existing tests still pass.",
        "- [ ] New tests cover the refactored path when behaviour changed.",
        "",
    ]
    if llm_hint:
        lines += ["## Assistant suggestion", "", llm_hint.strip(), ""]
    return "\n".join(lines)
