"""Regression tests for sandbox/approval_gate.py.

Covers bug #14 (CRITICAL): `apply()` previously did `sandbox_root / fa.path`
without containment check. Any prediction file with an absolute or `..`
path overwrote arbitrary host files when the user clicked "approve".
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sandbox.approval_gate import (  # noqa: E402
    ApprovalGate,
    _safe_join,
)
from sandbox.diff_predictor import (  # noqa: E402
    ChangeType,
    DiffPrediction,
    FileDiff,
)

# ─────────────────────────────────────────────────────────────────────
# _safe_join — direct unit tests
# ─────────────────────────────────────────────────────────────────────


class TestSafeJoin:
    def test_normal_relative_path_accepted(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        result = _safe_join(root, "src/foo.py")
        assert result.is_relative_to(root)

    def test_nested_relative_path_accepted(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        result = _safe_join(root, "a/b/c/d.txt")
        assert result.is_relative_to(root)

    def test_absolute_path_rejected(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        with pytest.raises(ValueError, match="(?i)absolute"):
            _safe_join(root, "/etc/passwd")

    def test_dot_dot_traversal_rejected(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        # `../../etc/passwd` resolves to a path outside root.
        with pytest.raises(ValueError):
            _safe_join(root, "../../etc/passwd")

    def test_dot_dot_within_path_rejected(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        with pytest.raises(ValueError):
            _safe_join(root, "src/../../etc/x")

    def test_empty_path_rejected(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        with pytest.raises(ValueError, match="(?i)empty"):
            _safe_join(root, "")

    def test_dot_path_accepted(self, tmp_path: Path) -> None:
        # `.` resolves to root itself — allowed.
        root = tmp_path.resolve()
        result = _safe_join(root, ".")
        assert result == root


# ─────────────────────────────────────────────────────────────────────
# ApprovalGate.apply — end-to-end with malicious prediction
# ─────────────────────────────────────────────────────────────────────


class TestApprovalGateApply:
    def _make_prediction(self, file_paths: list[str]) -> DiffPrediction:
        files = [
            FileDiff(
                path=p,
                change_type=ChangeType.MODIFIED,
                lines_added=1,
                lines_removed=0,
            )
            for p in file_paths
        ]
        return DiffPrediction(
            files=files,
            total_added=len(files),
            modified_files=len(files),
        )

    def test_apply_normal_paths(self, tmp_path: Path) -> None:
        sandbox = tmp_path / "sandbox"
        target = tmp_path / "target"
        sandbox.mkdir()
        target.mkdir()
        (sandbox / "good.txt").write_text("hello")

        gate = ApprovalGate()
        req = gate.create_request("req-1", self._make_prediction(["good.txt"]))
        gate.approve(req)
        applied = gate.apply(req, sandbox, target)

        assert "good.txt" in applied
        assert (target / "good.txt").read_text() == "hello"

    def test_apply_refuses_absolute_path_in_prediction(self, tmp_path: Path) -> None:
        """CRITICAL bug #14 regression.

        Pre-fix: a malicious prediction file path of `/tmp/evil` would
        cause `sandbox_root / "/tmp/evil"` to evaluate to `/tmp/evil`
        itself (Python `Path` quirk), and apply would write the host
        path. Post-fix: refused with a logged error; nothing written
        outside `target_root`.
        """
        sandbox = tmp_path / "sandbox"
        target = tmp_path / "target"
        sandbox.mkdir()
        target.mkdir()
        outside = tmp_path / "outside.txt"

        gate = ApprovalGate()
        req = gate.create_request("req-2", self._make_prediction([str(outside)]))
        gate.approve(req)
        applied = gate.apply(req, sandbox, target)

        assert applied == []  # refused
        assert not outside.exists()  # nothing written outside

    def test_apply_refuses_dot_dot_traversal(self, tmp_path: Path) -> None:
        """CRITICAL bug #14 regression for `..` form."""
        sandbox = tmp_path / "deep" / "sandbox"
        target = tmp_path / "deep" / "target"
        sandbox.mkdir(parents=True)
        target.mkdir(parents=True)

        # The prediction path tries to escape the target via `../../`
        # to write into the parent tmp_path.
        evil_rel = "../../escape.txt"
        gate = ApprovalGate()
        req = gate.create_request("req-3", self._make_prediction([evil_rel]))
        gate.approve(req)
        applied = gate.apply(req, sandbox, target)

        assert applied == []
        # No file was created in tmp_path's parent.
        assert not (tmp_path / "escape.txt").exists()

    def test_apply_skips_partial_unapproved_files(self, tmp_path: Path) -> None:
        sandbox = tmp_path / "s"
        target = tmp_path / "t"
        sandbox.mkdir()
        target.mkdir()
        (sandbox / "a.txt").write_text("A")
        (sandbox / "b.txt").write_text("B")

        gate = ApprovalGate()
        req = gate.create_request("req-4", self._make_prediction(["a.txt", "b.txt"]))
        gate.partial_approve(req, {"a.txt"})  # only a.txt approved
        applied = gate.apply(req, sandbox, target)

        assert "a.txt" in applied
        assert "b.txt" not in applied
        assert (target / "a.txt").exists()
        assert not (target / "b.txt").exists()

    def test_apply_pending_request_returns_empty(self, tmp_path: Path) -> None:
        gate = ApprovalGate()
        req = gate.create_request("req-5", self._make_prediction(["x.txt"]))
        # No approve / reject — still PENDING.
        assert gate.apply(req, tmp_path, tmp_path) == []
