"""Tests for the coder loop detector."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from agents.loop_detection import (
    LOOP_DETECTION_ENV_VAR,
    LoopDetector,
    get_detector,
    loop_detection_enabled,
    reset_registry_for_tests,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_registry_for_tests()
    yield
    reset_registry_for_tests()


# ---------------------------------------------------------------------------
# Env flag


class TestEnabledFlag:
    @pytest.mark.parametrize("v", ["1", "true", "YES", "on"])
    def test_truthy(self, monkeypatch: pytest.MonkeyPatch, v: str) -> None:
        monkeypatch.setenv(LOOP_DETECTION_ENV_VAR, v)
        assert loop_detection_enabled() is True

    @pytest.mark.parametrize("v", ["0", "false", "", "nope"])
    def test_falsy(self, monkeypatch: pytest.MonkeyPatch, v: str) -> None:
        monkeypatch.setenv(LOOP_DETECTION_ENV_VAR, v)
        assert loop_detection_enabled() is False

    def test_default_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(LOOP_DETECTION_ENV_VAR, raising=False)
        assert loop_detection_enabled() is False


# ---------------------------------------------------------------------------
# Detector behaviour


class TestRecordAndCheck:
    def test_first_hash_not_a_loop(self) -> None:
        det = LoopDetector(spec_id="x")
        assert det.record_and_check("aaaa") is False

    def test_distinct_hashes_not_a_loop(self) -> None:
        det = LoopDetector(spec_id="x")
        assert det.record_and_check("aaaa") is False
        assert det.record_and_check("bbbb") is False
        assert det.record_and_check("cccc") is False

    def test_simple_flip_flop_caught(self) -> None:
        # A → B → A — second occurrence of "A" must trigger.
        det = LoopDetector(spec_id="x")
        assert det.record_and_check("aaaa") is False
        assert det.record_and_check("bbbb") is False
        assert det.record_and_check("aaaa") is True
        assert det.last_loop_iteration is not None

    def test_three_step_loop_caught(self) -> None:
        det = LoopDetector(spec_id="x")
        for h in ("aaaa", "bbbb", "cccc"):
            assert det.record_and_check(h) is False
        # A→B→C→A → match at the 4th call.
        assert det.record_and_check("aaaa") is True

    def test_empty_hash_is_ignored(self) -> None:
        det = LoopDetector(spec_id="x")
        # Empty hashes don't get recorded — even if you call 5 times, no flag.
        for _ in range(5):
            assert det.record_and_check("") is False

    def test_buffer_size_caps_history(self) -> None:
        # Old hashes drop out of the window, so a repeat from way back
        # is NOT flagged as a loop.
        det = LoopDetector(spec_id="x")
        det.record_and_check("first")
        for h in ("a", "b", "c", "d"):
            det.record_and_check(h)
        # "first" left the buffer ~4 records ago.
        assert det.record_and_check("first") is False

    def test_reset_clears_buffer(self) -> None:
        det = LoopDetector(spec_id="x")
        det.record_and_check("aaaa")
        det.reset()
        assert det.buffer_snapshot() == []
        assert det.last_loop_iteration is None
        # And the next "aaaa" is fresh.
        assert det.record_and_check("aaaa") is False


# ---------------------------------------------------------------------------
# get_detector — process-local registry


class TestRegistry:
    def test_same_spec_returns_same_instance(self, tmp_path: Path) -> None:
        a = get_detector(tmp_path / "spec-1")
        b = get_detector(tmp_path / "spec-1")
        assert a is b

    def test_different_specs_get_distinct_detectors(self, tmp_path: Path) -> None:
        a = get_detector(tmp_path / "spec-1")
        b = get_detector(tmp_path / "spec-2")
        assert a is not b

    def test_state_isolation_across_specs(self, tmp_path: Path) -> None:
        a = get_detector(tmp_path / "spec-1")
        b = get_detector(tmp_path / "spec-2")
        a.record_and_check("aaaa")
        a.record_and_check("aaaa")  # flip-flop on spec-1
        # spec-2 didn't see anything → not a flip-flop on its side.
        assert b.record_and_check("aaaa") is False


# ---------------------------------------------------------------------------
# hash_diff


class TestHashDiff:
    def test_returns_empty_for_non_dir(self, tmp_path: Path) -> None:
        det = LoopDetector(spec_id="x")
        assert det.hash_diff(tmp_path / "ghost") == ""

    def test_returns_empty_for_non_git_dir(self, tmp_path: Path) -> None:
        det = LoopDetector(spec_id="x")
        assert det.hash_diff(tmp_path) == ""

    @pytest.mark.skipif(
        subprocess.run(["git", "--version"], capture_output=True).returncode != 0,
        reason="git not available",
    )
    def test_consistent_hash_for_same_diff(self, tmp_path: Path) -> None:
        # Set up a repo with one committed file then modify it.
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=tmp_path, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=tmp_path,
            check=True,
        )
        subprocess.run(["git", "config", "user.name", "test"], cwd=tmp_path, check=True)
        (tmp_path / "f.txt").write_text("hello\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmp_path, check=True)
        (tmp_path / "f.txt").write_text("hello\nworld\n", encoding="utf-8")

        det = LoopDetector(spec_id="x")
        h1 = det.hash_diff(tmp_path)
        h2 = det.hash_diff(tmp_path)
        assert h1 and h1 == h2
        assert len(h1) == 64  # SHA-256 hex


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
