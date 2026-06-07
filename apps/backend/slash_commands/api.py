"""Slash-command API.

Exposes two endpoints used by the Kanban Quick-Command bar:

  GET  /api/slash-commands?project_dir=<abs path>
       Returns the merged list of slash commands discovered from:
       - <project_dir>/.claude/commands/*.md   (project-scoped)
       - ~/.claude/commands/*.md               (user-scoped)
       Each entry carries the parsed YAML frontmatter so the UI can render
       a description tooltip without an extra round-trip.

  POST /api/slash-commands/run
       Body: { project_dir: str, command: str, args?: str }
       Runs the command as a single-turn SDK prompt via create_simple_client,
       i.e. `prompt = f"/{command} {args}".strip()`. The Claude Agent SDK
       resolves the slash command against the same filesystem sources (via
       setting_sources="project"/"user" inherited from the factory) and
       returns the result text.

The router is mounted from provider_api.py alongside the other domain APIs.

Security:
- `project_dir` must be an absolute path that points at an existing dir on
  disk; any attempt to escape via "..", symlinks pointing outside HOME, etc.
  is rejected before any filesystem read happens.
- `command` must match a simple slug regex so a malicious caller can't
  inject shell metacharacters or path traversal into the prompt.
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()

# Slug: lowercase letters / digits / hyphens / underscores / dots / colons.
# Matches both built-in commands like "compact" / "clear" and filesystem
# commands like "bmad-agent-bmm-dev".
_COMMAND_NAME_RE = re.compile(r"^[a-zA-Z0-9_./:-]{1,128}$")


def _safe_project_dir(raw: str) -> Path:
    """Resolve `raw` to an absolute path and reject obviously bogus inputs.

    We accept any existing directory on disk: enforcing a tighter rule (must
    be under HOME, must be a git repo, etc.) would break legitimate dev
    setups where projects live anywhere. The .claude/commands listing itself
    is read-only, so the worst a bad path can do is return [].
    """
    if not raw or len(raw) > 4096:
        raise HTTPException(status_code=400, detail="project_dir is required")
    p = Path(raw).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=400, detail=f"project_dir not found: {raw}")
    return p


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Very small YAML-ish frontmatter parser.

    The .claude/commands/*.md files in this repo use a simple
    `key: value` frontmatter block delimited by `---`. A full YAML
    parser would be overkill (and would pull in a runtime dep we don't
    need); we just split the leading block and read `key: value` lines.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    header = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")
    meta: dict[str, str] = {}
    for line in header.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta, body


def _scan_commands_dir(dir_path: Path, source: str) -> list[dict[str, Any]]:
    """Return one entry per *.md in `dir_path`. Missing dir → []."""
    if not dir_path.exists() or not dir_path.is_dir():
        return []
    items: list[dict[str, Any]] = []
    try:
        files = sorted(dir_path.glob("*.md"))
    except OSError:
        return []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, _ = _parse_frontmatter(text)
        items.append(
            {
                # File stem becomes the slash-command name (e.g. /bmad-agent-bmm-dev).
                "name": f.stem,
                "description": meta.get("description") or meta.get("desc") or "",
                "source": source,  # "project" | "user"
                "path": str(f),
            }
        )
    return items


# Built-in slash commands the SDK / CLI recognises AND that make sense in
# our one-shot Quick-Command bar. Commands that operate on a persistent
# conversation (/compact, /clear, /save, /resume…) are intentionally
# omitted: each click here spawns a fresh SDK client with an empty
# transcript, so those commands would always return "No messages to …".
# Self-contained commands like /review and /help work without prior context.
_BUILT_IN_COMMANDS: list[dict[str, str]] = [
    {
        "name": "review",
        "description": "Run the bundled code review skill on the current branch",
    },
    {
        "name": "help",
        "description": "Show built-in slash command help",
    },
]


@router.get("/api/slash-commands")
def list_slash_commands(project_dir: Annotated[str, Query()]):
    """List discovered slash commands for a project.

    Order: project commands first, then user commands, then built-ins.
    Duplicates (same `name`) are kept — the UI groups them by source.
    """
    proj = _safe_project_dir(project_dir)

    project_cmds = _scan_commands_dir(proj / ".claude" / "commands", "project")
    user_cmds = _scan_commands_dir(Path.home() / ".claude" / "commands", "user")
    built_ins = [
        {**cmd, "source": "built-in", "path": ""} for cmd in _BUILT_IN_COMMANDS
    ]

    return {
        "success": True,
        "commands": project_cmds + user_cmds + built_ins,
    }


async def _invoke_sdk_in_proactor_thread(proj: Path, prompt: str) -> tuple[bool, str]:
    """Run the SDK call on a dedicated thread with its own Proactor loop.

    Why: uvicorn's running event loop is sometimes a SelectorEventLoop on
    Windows (depending on Python / uvicorn / FastAPI versions), and
    SelectorEventLoop.subprocess_exec raises NotImplementedError. The Claude
    Agent SDK launches `claude.exe` as a subprocess, so we MUST run it on a
    loop that supports subprocess. Solution: spawn a worker thread, force a
    Proactor loop there, and execute the whole SDK conversation inside it.

    This pattern is robust regardless of how uvicorn is started (`--reload`,
    no-reload, `--loop asyncio`, `--loop uvloop`, etc.).

    Returns (success, text). On failure, text is the error message.
    """
    import asyncio as _a

    def _worker() -> tuple[bool, str]:
        # On Windows, force a Proactor loop in this thread. On POSIX, this
        # branch is a no-op (WindowsProactorEventLoopPolicy is undefined).
        if sys.platform == "win32":
            _policy_cls = getattr(_a, "WindowsProactorEventLoopPolicy", None)
            if _policy_cls is not None:
                _a.set_event_loop_policy(_policy_cls())
        loop = _a.new_event_loop()
        try:
            _a.set_event_loop(loop)
            return loop.run_until_complete(_sdk_call(proj, prompt))
        finally:
            try:
                loop.close()
            except Exception:
                pass

    # asyncio.to_thread schedules the worker on the default executor and
    # awaits its return value without blocking the FastAPI event loop.
    return await _a.to_thread(_worker)


async def _sdk_call(proj: Path, prompt: str) -> tuple[bool, str]:
    """The actual SDK conversation. Runs on the Proactor worker loop."""
    try:
        from core.simple_client import create_simple_client
    except ImportError as exc:
        return False, f"Claude Agent SDK not available: {exc}"

    try:
        client = create_simple_client(
            # "analyzer" is read-only with no MCP — safe baseline for a
            # one-shot user-triggered prompt.
            agent_type="analyzer",
            cwd=proj,
            max_turns=1,
        )
    except Exception as exc:
        logger.exception("[slash-commands] failed to build client")
        return False, f"failed to build SDK client: {exc}"

    response_text = ""
    try:
        async with client:
            await client.query(prompt)
            async for msg in client.receive_response():
                if type(msg).__name__ == "AssistantMessage" and hasattr(msg, "content"):
                    for block in msg.content:
                        if type(block).__name__ == "TextBlock" and hasattr(
                            block, "text"
                        ):
                            response_text += block.text
    except Exception as exc:
        logger.exception("[slash-commands] SDK call failed")
        return False, f"SDK call failed: {exc}"

    return True, response_text.strip()


@router.post("/api/slash-commands/run")
async def run_slash_command(payload: Annotated[dict, Body()]):
    """Fire a slash command as a single-turn SDK prompt.

    Body schema:
        project_dir: str   absolute path to the project (required)
        command:     str   slug, without leading slash (required)
        args:        str   optional free-text arguments appended to the prompt

    Response:
        success:   bool
        prompt:    str   the exact prompt sent to the SDK (for debugging)
        result:    str   the model's text response (success path only)
        error:     str   error message (failure path only)
    """
    project_dir_raw = (payload or {}).get("project_dir")
    command = (payload or {}).get("command")
    args = (payload or {}).get("args") or ""

    if not project_dir_raw or not command:
        raise HTTPException(
            status_code=400,
            detail="project_dir and command are required",
        )
    if not _COMMAND_NAME_RE.match(command):
        raise HTTPException(
            status_code=400, detail=f"invalid command name: {command!r}"
        )
    if not isinstance(args, str) or len(args) > 4000:
        raise HTTPException(
            status_code=400, detail="args must be a string ≤ 4000 chars"
        )

    proj = _safe_project_dir(project_dir_raw)
    prompt = f"/{command}".strip()
    if args.strip():
        prompt = f"{prompt} {args.strip()}"

    ok, text = await _invoke_sdk_in_proactor_thread(proj, prompt)
    if ok:
        return {"success": True, "prompt": prompt, "result": text}
    return {"success": False, "prompt": prompt, "error": text}
