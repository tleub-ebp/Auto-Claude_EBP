"""Regression test for browser_agent/visual_regression.py.

Covers the PIL file-handle leak in `compare()`: previously
`Image.open(path).convert("RGBA")` returned an in-memory image but the
underlying source file handle stayed open until garbage collection, which
on Windows blocks deletion / replacement of the source file.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


pytest.importorskip("PIL", reason="Pillow not installed")
from browser_agent.visual_regression import VisualRegressionEngine  # noqa: E402
from PIL import Image  # noqa: E402


def _make_image(path: Path, color: tuple[int, int, int] = (255, 255, 255)) -> None:
    """Create a small PNG at `path` filled with `color`."""
    img = Image.new("RGB", (16, 16), color)
    try:
        img.save(str(path), format="PNG")
    finally:
        img.close()


class TestComparePILFileHandleLeak:
    def test_compare_releases_baseline_file_after_call(self, tmp_path: Path) -> None:
        """After compare() returns, the baseline PNG must be deletable.

        Pre-fix: PIL kept the file handle open behind the .convert() call,
        which on Windows raised PermissionError on Path.unlink().
        """
        engine = VisualRegressionEngine(project_dir=tmp_path)

        baseline_src = tmp_path / "src.png"
        _make_image(baseline_src, color=(10, 20, 30))
        info = engine.set_baseline("home_page", baseline_src)
        baseline_path = Path(info.path)
        assert baseline_path.exists()

        current_path = tmp_path / "current.png"
        _make_image(current_path, color=(10, 20, 30))

        # Compare runs Image.open on baseline AND current.
        engine.compare("home_page", current_path)

        # If the file handle leaked, on Windows this unlink raises
        # PermissionError. On POSIX it silently succeeds even with a
        # leaked handle — but the test still locks the regression for
        # Windows users.
        baseline_path.unlink()
        current_path.unlink()

    def test_compare_releases_current_file_after_call(self, tmp_path: Path) -> None:
        """Same check, focused on the `current` screenshot."""
        engine = VisualRegressionEngine(project_dir=tmp_path)

        baseline_src = tmp_path / "src.png"
        _make_image(baseline_src, color=(255, 0, 0))
        engine.set_baseline("widget", baseline_src)

        current_path = tmp_path / "now.png"
        _make_image(current_path, color=(0, 255, 0))

        engine.compare("widget", current_path)

        # Should be free to unlink immediately.
        current_path.unlink()
