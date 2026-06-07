"""Tests for agent_health.persistence (disk + analytics ingest)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from agent_health import (
    AgentRun,
    HealthMonitor,
    default_state_path,
    ingest_from_analytics,
    load_from_disk,
    save_to_disk,
)


def _seed(monitor: HealthMonitor, agent: str, n: int) -> None:
    for i in range(n):
        monitor.record(
            AgentRun(
                agent_name=agent,
                success=i % 3 != 0,  # ~2/3 success
                duration_s=1.0 + i * 0.1,
                retries=i % 2,
                error="boom" if i % 5 == 0 else "",
            )
        )


# ----------------------------------------------------------------------
# Disk persistence


class TestSaveLoad:
    def test_save_creates_file(self, tmp_path: Path) -> None:
        m = HealthMonitor()
        _seed(m, "planner", 5)
        target = save_to_disk(m, tmp_path / "state.json")
        assert target.exists()
        assert json.loads(target.read_text()).get("version") == 1

    def test_round_trip(self, tmp_path: Path) -> None:
        m1 = HealthMonitor()
        _seed(m1, "planner", 7)
        _seed(m1, "coder", 3)

        save_to_disk(m1, tmp_path / "state.json")

        m2 = HealthMonitor()
        loaded = load_from_disk(m2, tmp_path / "state.json")
        assert loaded == 10
        assert sorted(m2.known_agents()) == ["coder", "planner"]
        assert len(m2._runs["planner"]) == 7  # noqa: SLF001 - test invariant
        assert len(m2._runs["coder"]) == 3  # noqa: SLF001

    def test_load_missing_file_returns_zero(self, tmp_path: Path) -> None:
        m = HealthMonitor()
        assert load_from_disk(m, tmp_path / "ghost.json") == 0
        assert m.known_agents() == []

    def test_load_corrupt_file_returns_zero(self, tmp_path: Path) -> None:
        f = tmp_path / "bad.json"
        f.write_text("{ not valid json")
        m = HealthMonitor()
        assert load_from_disk(m, f) == 0

    def test_load_unsupported_version_returns_zero(self, tmp_path: Path) -> None:
        f = tmp_path / "v99.json"
        f.write_text(json.dumps({"version": 99}))
        m = HealthMonitor()
        assert load_from_disk(m, f) == 0

    def test_load_replaces_existing_state(self, tmp_path: Path) -> None:
        m1 = HealthMonitor()
        _seed(m1, "planner", 3)
        save_to_disk(m1, tmp_path / "state.json")

        m2 = HealthMonitor()
        _seed(m2, "coder", 5)  # populated before load
        load_from_disk(m2, tmp_path / "state.json")
        # Coder is gone — load replaces in-memory state.
        assert "coder" not in m2.known_agents()
        assert "planner" in m2.known_agents()

    def test_baseline_round_trip(self, tmp_path: Path) -> None:
        m = HealthMonitor()
        _seed(m, "planner", 50)  # enough to compute a baseline
        assert m._baselines.get("planner") is not None  # noqa: SLF001

        save_to_disk(m, tmp_path / "state.json")
        m2 = HealthMonitor()
        load_from_disk(m2, tmp_path / "state.json")
        assert m2._baselines.get("planner") == m._baselines["planner"]  # noqa: SLF001

    def test_corrupt_run_records_skipped(self, tmp_path: Path) -> None:
        # Manually write a state with one good run + one bad one.
        f = tmp_path / "state.json"
        f.write_text(
            json.dumps(
                {
                    "version": 1,
                    "saved_at": 0,
                    "window_size": 50,
                    "runs": {
                        "planner": [
                            {
                                "agent_name": "planner",
                                "success": True,
                                "duration_s": 1.0,
                            },
                            {"missing_required_field": True},
                        ]
                    },
                    "baselines": {},
                }
            )
        )
        m = HealthMonitor()
        loaded = load_from_disk(m, f)
        assert loaded == 1  # bad row dropped silently

    def test_default_state_path_under_project(self, tmp_path: Path) -> None:
        path = default_state_path(tmp_path)
        assert path == tmp_path / ".workpilot" / "agent_health" / "state.json"


# ----------------------------------------------------------------------
# Analytics ingest


class TestAnalyticsIngest:
    def test_ingest_skips_when_module_unavailable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Patch the *target* of the local-imported names to raise ImportError.
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("analytics."):
                raise ImportError("simulated")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        m = HealthMonitor()
        assert ingest_from_analytics(m) == 0
        assert m.known_agents() == []

    def test_ingest_translates_phases_to_runs(self) -> None:
        m = HealthMonitor()

        # Build fake BuildPhase objects.
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc).replace(tzinfo=None)

        def _phase(phase_type, *, success=True, duration=1.5, started_at=None):
            p = MagicMock()
            p.phase_type = phase_type
            p.duration_seconds = duration
            p.started_at = started_at or now
            p.completed_at = (
                (started_at or now) + timedelta(seconds=duration) if success else None
            )
            p.error_message = "" if success else "boom"
            return p

        phases = [
            _phase("planner", success=True, duration=1.0),
            _phase("coder", success=True, duration=2.0),
            _phase("coder", success=False, duration=0.5),
            _phase("", success=True),  # no phase_type → skipped
        ]

        # Build a fake DB session that returns those phases.
        fake_query = MagicMock()
        fake_query.order_by.return_value = fake_query
        fake_query.limit.return_value = fake_query
        fake_query.all.return_value = phases
        fake_db = MagicMock()
        fake_db.query.return_value = fake_query

        # Patch the imports inside ingest_from_analytics.
        with patch.dict(
            "sys.modules",
            {
                "analytics.database": MagicMock(get_db=lambda: iter([fake_db])),
                "analytics.database_schema": MagicMock(
                    BuildPhase=MagicMock(), Build=MagicMock()
                ),
            },
        ):
            ingested = ingest_from_analytics(m)

        assert ingested == 3  # the empty phase_type was skipped
        assert sorted(m.known_agents()) == ["coder", "planner"]
        # The failed coder run is recorded as failure
        coder_runs = list(m._runs["coder"])  # noqa: SLF001
        assert any(not r.success for r in coder_runs)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
