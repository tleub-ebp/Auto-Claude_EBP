"""Server-side agent run execution.

Replaces the Electron AgentManager in server mode: runs are queued and
executed on the server as ``python run.py --spec <name> --project-dir
<server clone>`` subprocesses, tracked in the ``agent_runs`` table, and
streamed to clients through the existing WebSocket pipeline (the agent's
streaming wrapper authenticates with the injected WORKPILOT_WS_TOKEN).

Concurrency model:
- Global semaphore: at most ``MAX_CONCURRENT_RUNS`` agent processes.
- Per-spec exclusivity is enforced upstream by the claim model; the run
  manager additionally refuses two simultaneous runs on the same spec.
- A run survives client disconnections — it belongs to the server.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import AgentRun, SpecIndex, User
from server.services.events import emit_board_event
from server.services.secrets import get_user_secret
from sqlalchemy import select

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[2]

#: Extra args per phase, mirroring what the Electron AgentManager passes.
PHASE_ARGS: dict[str, list[str]] = {
    "build": [],
    "qa": ["--qa"],
    "merge": ["--merge"],
}

#: Secrets injected into the run env when the launching user configured them.
USER_SECRET_ENV: dict[str, str] = {
    "azure_pat": "AZURE_DEVOPS_PAT",
    "jira_token": "JIRA_API_TOKEN",
    "linear_api_key": "LINEAR_API_KEY",
    "github_token": "GITHUB_TOKEN",
    "gitlab_token": "GITLAB_TOKEN",
}


class RunManagerError(RuntimeError):
    pass


def _mint_ws_token(hours: int = 12) -> str:
    """Long-lived service token for the agent's streaming connection."""
    import jwt as pyjwt

    settings = get_settings()
    now = datetime.now(UTC)
    return pyjwt.encode(
        {
            "iss": settings.jwt_issuer,
            "sub": "service:agent",
            "name": "WorkPilot Agent",
            "role": "service",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(hours=hours)).timestamp()),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


class RunManager:
    """Singleton orchestrating server-side agent subprocesses."""

    def __init__(self) -> None:
        self._semaphore: asyncio.Semaphore | None = None
        self._active: dict[str, asyncio.subprocess.Process] = {}  # run_id -> proc
        self._running_specs: set[str] = set()

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(get_settings().max_concurrent_runs)
        return self._semaphore

    async def start_run(
        self,
        spec: SpecIndex,
        project_id: str,
        server_path: str,
        phase: str,
        user_id: str,
        model: str | None = None,
    ) -> AgentRun:
        """Queue a run and return its DB row immediately (status=queued)."""
        if phase not in PHASE_ARGS:
            raise RunManagerError(f"Unknown phase: {phase}")
        if spec.id in self._running_specs:
            raise RunManagerError("A run is already in progress for this spec")

        async with get_session_factory()() as db:
            run = AgentRun(
                spec_id=spec.id,
                phase=phase,
                started_by=user_id,
                model=model,
                status="queued",
            )
            db.add(run)
            await db.commit()
            run_id = run.id

        self._running_specs.add(spec.id)
        asyncio.get_running_loop().create_task(
            self._execute(
                run_id=run_id,
                spec_id=spec.id,
                spec_name=spec.spec_name,
                project_id=project_id,
                server_path=server_path,
                phase=phase,
                user_id=user_id,
                model=model,
            )
        )
        return run

    async def cancel_run(self, run_id: str) -> bool:
        proc = self._active.get(run_id)
        if proc is None:
            return False
        proc.terminate()
        return True

    async def _build_env(self, user_id: str) -> dict[str, str]:
        """Run env = server env + WS token + the launcher's integration secrets."""
        import os

        env = dict(os.environ)
        env["WORKPILOT_WS_TOKEN"] = _mint_ws_token()
        env["WORKPILOT_RUN_USER_ID"] = user_id
        async with get_session_factory()() as db:
            for kind, env_name in USER_SECRET_ENV.items():
                try:
                    value = await get_user_secret(db, user_id, kind)
                except Exception as e:  # vault misconfig must not block runs
                    logger.warning("Could not read secret %s: %s", kind, e)
                    continue
                if value:
                    env[env_name] = value
        return env

    async def _execute(
        self,
        run_id: str,
        spec_id: str,
        spec_name: str,
        project_id: str,
        server_path: str,
        phase: str,
        user_id: str,
        model: str | None,
    ) -> None:
        try:
            async with self._get_semaphore():
                await self._set_run_status(run_id, "running")
                await self._notify(
                    project_id, spec_id, spec_name, run_id, phase, user_id, "running"
                )

                cmd = [
                    sys.executable,
                    str(BACKEND_DIR / "run.py"),
                    "--spec",
                    spec_name,
                    "--project-dir",
                    server_path,
                    *PHASE_ARGS[phase],
                ]
                if model:
                    cmd += ["--model", model]

                env = await self._build_env(user_id)
                logger.info("Run %s starting: %s", run_id, " ".join(cmd[:6]))
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=str(BACKEND_DIR),
                    env=env,
                    stdout=asyncio.subprocess.DEVNULL,  # agents log to task_logs/WS
                    stderr=asyncio.subprocess.PIPE,
                )
                self._active[run_id] = proc
                _, stderr = await proc.communicate()

                if proc.returncode == 0:
                    await self._set_run_status(run_id, "succeeded")
                    status = "succeeded"
                else:
                    tail = (stderr or b"").decode(errors="replace")[-2000:]
                    await self._set_run_status(run_id, "failed", error=tail)
                    status = "failed"
                await self._notify(
                    project_id, spec_id, spec_name, run_id, phase, user_id, status
                )
        except Exception as e:
            logger.exception("Run %s crashed in the manager", run_id)
            await self._set_run_status(run_id, "failed", error=str(e)[:2000])
        finally:
            self._active.pop(run_id, None)
            self._running_specs.discard(spec_id)

    async def _set_run_status(
        self, run_id: str, status: str, error: str | None = None
    ) -> None:
        async with get_session_factory()() as db:
            run = await db.get(AgentRun, run_id)
            if run is None:
                return
            run.status = status
            run.error = error
            if status in {"succeeded", "failed", "cancelled"}:
                run.finished_at = datetime.now(UTC)
            await db.commit()

    async def _notify(
        self,
        project_id: str,
        spec_id: str,
        spec_name: str,
        run_id: str,
        phase: str,
        user_id: str,
        status: str,
    ) -> None:
        async with get_session_factory()() as db:
            user_name = await db.scalar(
                select(User.display_name).where(User.id == user_id)
            )
        emit_board_event(
            project_id,
            "spec_status_changed",
            {
                "spec_id": spec_id,
                "spec_name": spec_name,
                "run_id": run_id,
                "phase": phase,
                "run_status": status,
                "user_id": user_id,
                "user_name": user_name or "",
            },
        )


_run_manager: RunManager | None = None


def get_run_manager() -> RunManager:
    global _run_manager
    if _run_manager is None:
        _run_manager = RunManager()
    return _run_manager
