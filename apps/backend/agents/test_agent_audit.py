"""Tests for the audit_agent / audit_event / audit_decision facade."""

from __future__ import annotations

from pathlib import Path

import pytest
from agents.agent_audit import audit_agent, audit_decision, audit_event
from audit_trail import AuditTrail


def _read_trail(project_dir: Path) -> AuditTrail:
    """Read the trail back as the rest of the system would."""
    return AuditTrail(
        storage_dir=project_dir / ".workpilot" / "audit-trail",
        name="default",
    )


# ---------------------------------------------------------------------------
# audit_event


class TestAuditEvent:
    def test_writes_event_with_correlation_id(self, tmp_path: Path) -> None:
        audit_event(
            tmp_path,
            kind="agent_invoked",
            actor="planner",
            correlation_id="spec-1",
            summary="started",
        )
        events = _read_trail(tmp_path).all()
        assert len(events) == 1
        assert events[0].actor == "planner"
        assert events[0].correlation_id == "spec-1"

    def test_payload_round_trips(self, tmp_path: Path) -> None:
        audit_event(
            tmp_path,
            kind="agent_invoked",
            actor="coder",
            correlation_id="s",
            summary="x",
            payload={"model": "opus-4-7", "iter": 3},
        )
        events = _read_trail(tmp_path).all()
        assert events[0].payload == {"model": "opus-4-7", "iter": 3}

    def test_never_raises_on_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force AuditTrail.append to blow up — the helper must swallow it.
        from agents import agent_audit

        class BoomTrail:
            def append(self, **_kw):
                raise RuntimeError("boom")

        monkeypatch.setattr(agent_audit, "_open_trail", lambda *_a, **_k: BoomTrail())
        # Must not raise.
        audit_event(
            tmp_path,
            kind="agent_invoked",
            actor="x",
            correlation_id="x",
            summary="x",
        )

    def test_no_op_when_audit_trail_unavailable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from agents import agent_audit

        # Simulate "audit_trail import failed at module load".
        monkeypatch.setattr(agent_audit, "AuditTrail", None)
        audit_event(
            tmp_path,
            kind="agent_invoked",
            actor="x",
            correlation_id="x",
            summary="x",
        )
        # No trail dir created.
        assert not (tmp_path / ".workpilot" / "audit-trail").exists()


# ---------------------------------------------------------------------------
# audit_agent context manager


class TestAuditAgentContext:
    def test_records_invoked_then_completed(self, tmp_path: Path) -> None:
        spec = tmp_path / "spec-1"
        spec.mkdir()
        with audit_agent(
            tmp_path, actor="coder", spec_dir=spec, metadata={"model": "opus"}
        ):
            pass
        events = _read_trail(tmp_path).all()
        kinds = [e.kind.value for e in events]
        assert kinds == ["agent_invoked", "agent_completed"]
        assert events[0].correlation_id == "spec-1"  # spec_dir.name
        assert events[0].payload["model"] == "opus"
        assert events[0].payload["spec_dir"] == str(spec)

    def test_records_failure_and_reraises(self, tmp_path: Path) -> None:
        spec = tmp_path / "spec-2"
        spec.mkdir()
        with pytest.raises(ValueError, match="boom"):
            with audit_agent(tmp_path, actor="coder", spec_dir=spec):
                raise ValueError("boom")
        events = _read_trail(tmp_path).all()
        kinds = [e.kind.value for e in events]
        assert kinds == ["agent_invoked", "agent_failed"]
        assert "boom" in events[1].payload["error"]
        # Error string is truncated to 500 chars to prevent secret leakage
        # via large stack traces.
        assert len(events[1].payload["error"]) <= 500

    def test_correlation_id_falls_back_to_actor_when_no_spec(
        self, tmp_path: Path
    ) -> None:
        with audit_agent(tmp_path, actor="planner"):
            pass
        events = _read_trail(tmp_path).all()
        assert events[0].correlation_id == "planner"

    def test_explicit_correlation_id_wins(self, tmp_path: Path) -> None:
        with audit_agent(
            tmp_path,
            actor="coder",
            spec_dir=tmp_path / "spec-x",
            correlation_id="task-42",
        ):
            pass
        events = _read_trail(tmp_path).all()
        assert events[0].correlation_id == "task-42"

    def test_reraises_even_when_audit_unavailable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from agents import agent_audit

        monkeypatch.setattr(agent_audit, "AuditTrail", None)
        with pytest.raises(KeyError):
            with audit_agent(tmp_path, actor="x"):
                raise KeyError("x")


# ---------------------------------------------------------------------------
# audit_decision


class TestAuditDecision:
    def test_writes_decision_event(self, tmp_path: Path) -> None:
        spec = tmp_path / "spec-d"
        spec.mkdir()
        audit_decision(
            tmp_path,
            actor="model_router",
            spec_dir=spec,
            decision_id="d-1",
            title="Pick a model",
            chosen="opus-4-7",
            rationale="complex task",
            rejected=("haiku-4-5", "sonnet-4-6"),
        )
        events = _read_trail(tmp_path).all()
        assert len(events) == 1
        assert events[0].kind.value == "decision_made"
        assert events[0].payload["chosen_option"] == "opus-4-7"
        assert events[0].payload["rejected_options"] == ["haiku-4-5", "sonnet-4-6"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
