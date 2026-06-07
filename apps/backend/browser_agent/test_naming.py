"""Tests for browser_agent._naming.

This helper centralizes the artifact-name sanitization rule that used
to be duplicated between browser_controller (screenshots) and
visual_regression (baselines). Keeping the two in sync via tests
prevents regressions when one site is updated and the other is forgotten.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from browser_agent._naming import safe_artifact_path, sanitize_name  # noqa: E402


class TestSanitizeName:
    def test_simple_name_passes_through(self) -> None:
        assert sanitize_name("login_button", fallback="x") == "login_button"

    def test_hyphens_dots_underscores_preserved(self) -> None:
        assert sanitize_name("test-1.2_v3", fallback="x") == "test-1.2_v3"

    def test_path_separators_replaced(self) -> None:
        result = sanitize_name("foo/bar/baz", fallback="x")
        assert "/" not in result and "\\" not in result

    def test_traversal_neutralized(self) -> None:
        result = sanitize_name("../../etc/evil", fallback="x")
        assert ".." not in result
        assert "/" not in result

    def test_null_byte_stripped(self) -> None:
        result = sanitize_name("foo\0bar", fallback="x")
        assert "\0" not in result

    def test_empty_returns_fallback(self) -> None:
        assert sanitize_name("", fallback="screenshot") == "screenshot"
        assert sanitize_name(None, fallback="baseline") == "baseline"  # type: ignore[arg-type]

    def test_all_unsafe_returns_fallback(self) -> None:
        # `///` becomes `___` then strip("._") leaves empty → fallback.
        assert sanitize_name("///", fallback="x") == "x"

    def test_leading_dot_stripped(self) -> None:
        # Hidden-file shenanigans guarded by .strip("._").
        assert not sanitize_name(".hidden", fallback="x").startswith(".")

    def test_max_len_enforced(self) -> None:
        result = sanitize_name("a" * 500, fallback="x", max_len=64)
        assert len(result) == 64

    def test_default_max_len_128(self) -> None:
        result = sanitize_name("a" * 500, fallback="x")
        assert len(result) == 128


class TestSafeArtifactPath:
    def test_normal_name_under_root(self, tmp_path: Path) -> None:
        path = safe_artifact_path(tmp_path, "login", ".png", fallback="x")
        assert path.is_relative_to(tmp_path.resolve())
        assert path.name == "login.png"

    def test_name_with_traversal_does_not_escape(self, tmp_path: Path) -> None:
        # Even with a malicious name, the result stays under root.
        path = safe_artifact_path(tmp_path, "../../etc/evil", ".png", fallback="x")
        assert path.is_relative_to(tmp_path.resolve())

    def test_empty_name_uses_fallback(self, tmp_path: Path) -> None:
        path = safe_artifact_path(tmp_path, "", ".png", fallback="screenshot")
        assert path.name == "screenshot.png"

    def test_suffix_preserved(self, tmp_path: Path) -> None:
        path = safe_artifact_path(tmp_path, "x", "_diff.png", fallback="x")
        assert path.name.endswith("_diff.png")


class TestBackwardCompat:
    """The visual_regression `_sanitize_baseline_name` wrapper must keep
    the same observable behaviour as before the refactor."""

    def test_baseline_wrapper_uses_baseline_fallback(self) -> None:
        from browser_agent.visual_regression import _sanitize_baseline_name

        assert _sanitize_baseline_name("") == "baseline"
        assert _sanitize_baseline_name("home_page") == "home_page"

    def test_baseline_wrapper_caps_at_default_128(self) -> None:
        from browser_agent.visual_regression import _sanitize_baseline_name

        assert len(_sanitize_baseline_name("a" * 500)) == 128
