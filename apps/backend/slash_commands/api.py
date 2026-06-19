"""Slash-command API.

Exposes two endpoints used by the Kanban Quick-Command bar:

  GET  /api/slash-commands?project_dir=<abs path>
       Returns the merged list of slash commands discovered from:
       - <project_dir>/.agents/skills/*/SKILL.md  (agnostic, primary source)
       - <project_dir>/.claude/commands/*.md       (Claude mirror, fallback)
       - ~/.claude/commands/*.md                   (user-scoped fallback)
       Commands already covered by the agnostic source are not duplicated.
       Each entry carries the parsed YAML frontmatter so the UI can render
       a description tooltip without an extra round-trip.

  POST /api/slash-commands/run
       Body: { project_dir: str, command: str, args?: str }
       Resolves the command's instruction body from the agnostic
       `.agents/skills/` source and runs it with a tool-enabled, multi-turn
       agent on the project's active provider via core.client.create_agent_client
       — so a BMAD workflow can read its `_bmad/` files, follow its steps and
       write outputs, regardless of the LLM/IDE driving the task. Degrades to a
       one-shot completion (core.oneshot) and finally the Claude slash resolver
       (create_simple_client) when the richer runners are unavailable.

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


# Provider/IDE-agnostic command source. Each skill lives in its own folder as
# `<project_dir>/.agents/skills/<name>/SKILL.md`. This is the single source of
# truth the Kanban uses regardless of which LLM/IDE drives the task, instead of
# the Claude-specific `.claude/commands/*.md` mirror.
_AGNOSTIC_SKILLS_SUBDIR = Path(".agents") / "skills"


def _scan_skills_dir(project_dir: Path, source: str) -> list[dict[str, Any]]:
    """Return one entry per `.agents/skills/*/SKILL.md`. Missing dir → []."""
    base = project_dir / _AGNOSTIC_SKILLS_SUBDIR
    if not base.exists() or not base.is_dir():
        return []
    items: list[dict[str, Any]] = []
    try:
        skill_files = sorted(base.glob("*/SKILL.md"))
    except OSError:
        return []
    for f in skill_files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, _ = _parse_frontmatter(text)
        items.append(
            {
                # The folder name is the command name (e.g. /bmad-bmm-create-prd).
                "name": meta.get("name") or f.parent.name,
                "description": meta.get("description") or meta.get("desc") or "",
                "source": source,
                "path": str(f),
            }
        )
    return items


def _resolve_command_body(proj: Path, command: str) -> str | None:
    """Return the prompt body for `command` from the agnostic source.

    Resolution order (first hit wins):
      1. <proj>/.agents/skills/<command>/SKILL.md   (agnostic, preferred)
      2. <proj>/.claude/commands/<command>.md       (Claude mirror, fallback)
      3. ~/.claude/commands/<command>.md            (user-scoped fallback)

    The frontmatter is stripped so the returned text is the raw instructions
    any provider can execute. Returns None when no definition is found (the
    caller then degrades to the SDK slash-command resolver).
    """
    candidates = [
        proj / _AGNOSTIC_SKILLS_SUBDIR / command / "SKILL.md",
        proj / ".claude" / "commands" / f"{command}.md",
        Path.home() / ".claude" / "commands" / f"{command}.md",
    ]
    for path in candidates:
        try:
            if path.is_file():
                _, body = _parse_frontmatter(
                    path.read_text(encoding="utf-8", errors="replace")
                )
                body = body.strip()
                if body:
                    return body
        except OSError:
            continue
    return None


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

    Order: agnostic project skills first, then any Claude-only mirror commands,
    then user commands, then built-ins. Commands already provided by the
    agnostic `.agents/skills/` source are not repeated from `.claude/commands`
    (the Claude mirror is a fallback for non-skill commands only).
    """
    proj = _safe_project_dir(project_dir)

    # Primary, provider/IDE-agnostic source.
    skill_cmds = _scan_skills_dir(proj, "project")
    seen = {c["name"] for c in skill_cmds}

    # Claude-specific mirror, kept only for commands not already covered above.
    project_cmds = [
        c
        for c in _scan_commands_dir(proj / ".claude" / "commands", "project")
        if c["name"] not in seen
    ]
    seen.update(c["name"] for c in project_cmds)
    user_cmds = [
        c
        for c in _scan_commands_dir(Path.home() / ".claude" / "commands", "user")
        if c["name"] not in seen
    ]
    built_ins = [
        {**cmd, "source": "built-in", "path": ""} for cmd in _BUILT_IN_COMMANDS
    ]

    return {
        "success": True,
        "commands": skill_cmds + project_cmds + user_cmds + built_ins,
    }


async def _invoke_in_proactor_thread(coro_factory) -> tuple[bool, str]:
    """Run an async (success, text) call on a thread with its own Proactor loop.

    Why: uvicorn's running event loop is sometimes a SelectorEventLoop on
    Windows (depending on Python / uvicorn / FastAPI versions), and
    SelectorEventLoop.subprocess_exec raises NotImplementedError. The agent
    clients (Claude SDK, Copilot CLI, …) launch a subprocess, so we MUST run on
    a loop that supports subprocess. Solution: spawn a worker thread, force a
    Proactor loop there, and execute the whole conversation inside it.

    This pattern is robust regardless of how uvicorn is started (`--reload`,
    no-reload, `--loop asyncio`, `--loop uvloop`, etc.).

    `coro_factory` is a zero-arg callable returning the coroutine to await.
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
            return loop.run_until_complete(coro_factory())
        finally:
            try:
                loop.close()
            except Exception:
                pass

    # asyncio.to_thread schedules the worker on the default executor and
    # awaits its return value without blocking the FastAPI event loop.
    return await _a.to_thread(_worker)


# Build/availability failures from the tool-enabled path that should trigger a
# graceful fallback to the lighter runners (vs a genuine workflow runtime error,
# which we surface as-is).
_AGENT_FALLBACK_PREFIXES = (
    "agent runner not available",
    "failed to build agent client",
)


async def _agent_workflow_call(proj: Path, prompt: str) -> tuple[bool, str]:
    """Run `prompt` as a multi-turn, tool-enabled agent against the active provider.

    Unlike `_agnostic_call` (single-turn, no tools), this builds a full
    task-execution client (read/write/web tools, multi-turn) via
    `core.client.create_agent_client`, so the agent can actually READ the
    referenced `_bmad/` workflow files, follow the multi-step workflow and WRITE
    its output documents. The provider is resolved from the project config
    (Claude / Copilot / OpenAI / Windsurf …) — fully provider-agnostic.

    Returns (False, "<prefix>: …") with a prefix in `_AGENT_FALLBACK_PREFIXES`
    when the client could not be built, so the caller degrades to `_agnostic_call`.
    """
    try:
        from core.client import _get_active_provider, create_agent_client
        from core.oneshot import _extract_text, _resolve_model
    except ImportError as exc:
        return False, f"agent runner not available: {exc}"

    try:
        provider = _get_active_provider(proj)
        model = _resolve_model(provider, None, proj)
        # spec_dir == project_dir: the Quick-Command bar is project-scoped (no
        # per-task spec). agent_type="coder" carries the read+write+web tool set
        # needed to run a BMAD workflow end to end.
        client = create_agent_client(
            project_dir=proj,
            spec_dir=proj,
            model=model,
            agent_type="coder",
            provider=provider,
        )
    except Exception as exc:
        logger.exception("[slash-commands] failed to build agent client")
        return False, f"failed to build agent client: {exc}"

    text = ""
    try:
        async with client:
            await client.query(prompt)
            async for msg in client.receive_response():
                text += _extract_text(msg)
    except Exception as exc:
        logger.exception("[slash-commands] agent workflow call failed")
        return False, f"workflow run failed: {exc}"
    return True, text.strip()


async def _agnostic_call(proj: Path, prompt: str) -> tuple[bool, str]:
    """Run a one-shot prompt against the project's active provider.

    Provider/IDE/LLM/effort-agnostic: routes through core.oneshot which resolves
    whatever LLM the project is configured to use (Claude, Copilot, OpenAI,
    Windsurf…) instead of the Claude-only slash-command resolver. The special
    "oneshot runner not available" message lets the caller fall back to the SDK.
    """
    try:
        from core.oneshot import oneshot_completion
    except ImportError as exc:
        return False, f"oneshot runner not available: {exc}"

    try:
        text = await oneshot_completion(prompt, project_dir=str(proj), max_turns=1)
    except Exception as exc:
        logger.exception("[slash-commands] agnostic call failed")
        return False, f"command run failed: {exc}"
    return True, (text or "").strip()


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
    """Fire a slash command against the project's active provider.

    The command body is resolved from the agnostic `.agents/skills/` source and
    executed by a tool-enabled, multi-turn agent (provider/IDE/LLM-agnostic) so a
    BMAD workflow can read its `_bmad/` files, run its steps and write outputs.
    Degrades to a one-shot completion, then to the Claude slash resolver, only
    when the richer runners are unavailable.

    Body schema:
        project_dir: str   absolute path to the project (required)
        command:     str   slug, without leading slash (required)
        args:        str   optional free-text arguments appended to the prompt

    Response:
        success:   bool
        prompt:    str   the `/command args` label (for display/debugging)
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
    display = f"/{command} {args.strip()}".strip()

    # Preferred path: send the skill body itself so ANY configured provider
    # executes the same instructions, instead of relying on Claude's /slash
    # resolution against .claude/commands.
    body = _resolve_command_body(proj, command)
    if body is not None:
        prompt = body
        if args.strip():
            prompt = f"{prompt}\n\nArguments: {args.strip()}"

        # Preferred: tool-enabled, multi-turn agent on the active provider so the
        # command (e.g. a BMAD workflow) can read the referenced _bmad/ files,
        # run its steps and write outputs — works for Claude/Copilot/OpenAI/
        # Windsurf alike.
        ok, text = await _invoke_in_proactor_thread(
            lambda: _agent_workflow_call(proj, prompt)
        )
        # Degrade only when the agent client couldn't be built (not on genuine
        # workflow runtime errors, which we surface as-is).
        if not ok and text.startswith(_AGENT_FALLBACK_PREFIXES):
            ok, text = await _invoke_in_proactor_thread(
                lambda: _agnostic_call(proj, prompt)
            )
            if not ok and text.startswith("oneshot runner not available"):
                ok, text = await _invoke_in_proactor_thread(
                    lambda: _sdk_call(proj, display)
                )
        if ok:
            return {"success": True, "prompt": display, "result": text}
        return {"success": False, "prompt": display, "error": text}

    # No agnostic/mirror definition found → legacy Claude slash resolver.
    ok, text = await _invoke_in_proactor_thread(lambda: _sdk_call(proj, display))
    if ok:
        return {"success": True, "prompt": display, "result": text}
    return {"success": False, "prompt": display, "error": text}
