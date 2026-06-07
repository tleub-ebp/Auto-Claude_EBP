"""
Visual Regression Engine
=========================

Screenshot comparison engine for visual regression testing.
Uses Pillow for pixel-by-pixel diff with configurable threshold.
"""

import json
import shutil
from datetime import datetime
from pathlib import Path

from ._naming import sanitize_name
from .models import BaselineInfo, ComparisonResult


def _sanitize_baseline_name(name: str, *, max_len: int = 128) -> str:
    """Backwards-compatible wrapper around the shared sanitizer.

    Kept as a thin alias so existing callers (and tests) keep working
    while the canonical implementation lives in `_naming.sanitize_name`.
    """
    return sanitize_name(name, fallback="baseline", max_len=max_len)


class VisualRegressionEngine:
    """Manages baselines and performs visual screenshot comparisons."""

    def __init__(self, project_dir: Path, threshold: float = 95.0):
        self.project_dir = Path(project_dir)
        self.baselines_dir = (
            self.project_dir / ".workpilot" / "browser-agent" / "baselines"
        )
        self.diffs_dir = self.project_dir / ".workpilot" / "browser-agent" / "diffs"
        self.threshold = threshold

        self.baselines_dir.mkdir(parents=True, exist_ok=True)
        self.diffs_dir.mkdir(parents=True, exist_ok=True)

    def set_baseline(self, name: str, screenshot_path: Path) -> BaselineInfo:
        """Promote a screenshot to become a baseline."""
        screenshot_path = Path(screenshot_path)
        if not screenshot_path.exists():
            raise FileNotFoundError(f"Screenshot not found: {screenshot_path}")

        safe_name = _sanitize_baseline_name(name)
        baseline_path = self.baselines_dir / f"{safe_name}.png"
        shutil.copy2(str(screenshot_path), str(baseline_path))

        # Save metadata
        try:
            from PIL import Image

            with Image.open(baseline_path) as img:
                w, h = img.size
        except Exception:
            w, h = 0, 0

        meta = {
            "name": name,
            "created_at": datetime.now().isoformat(),
            "source": str(screenshot_path),
            "width": w,
            "height": h,
        }
        meta_path = self.baselines_dir / f"{safe_name}.json"
        meta_path.write_text(json.dumps(meta, indent=2))

        return BaselineInfo(
            name=name,
            path=str(baseline_path),
            created_at=meta["created_at"],
            width=w,
            height=h,
        )

    def compare(self, name: str, current_path: Path) -> ComparisonResult:
        """Compare a current screenshot against its baseline."""
        current_path = Path(current_path)
        safe_name = _sanitize_baseline_name(name)
        baseline_path = self.baselines_dir / f"{safe_name}.png"

        if not baseline_path.exists():
            raise FileNotFoundError(
                f"No baseline found for '{name}'. Set a baseline first."
            )
        if not current_path.exists():
            raise FileNotFoundError(f"Current screenshot not found: {current_path}")

        try:
            from PIL import Image, ImageChops
        except ImportError:
            raise RuntimeError("Pillow is not installed. Run: pip install Pillow")

        # PIL is lazy: `Image.open(...).convert(...)` returns a new image in
        # memory but the underlying file handle of the source stays open
        # until garbage-collected. On Windows that prevents the source
        # file from being deleted or replaced. Use `with` to force close.
        with Image.open(baseline_path) as src:
            baseline_img = src.convert("RGBA")
        with Image.open(current_path) as src:
            current_img = src.convert("RGBA")

        # Resize current to match baseline if dimensions differ
        if current_img.size != baseline_img.size:
            current_img = current_img.resize(
                baseline_img.size, Image.Resampling.LANCZOS
            )

        # Compute pixel diff
        diff = ImageChops.difference(baseline_img, current_img)
        diff_data = list(diff.getdata())
        total_pixels = len(diff_data)

        # Count pixels that differ (with small tolerance for anti-aliasing)
        tolerance = 10
        diff_pixels = sum(
            1
            for pixel in diff_data
            if any(channel > tolerance for channel in pixel[:3])
        )

        match_percentage = (
            ((total_pixels - diff_pixels) / total_pixels) * 100
            if total_pixels > 0
            else 100.0
        )
        passed = match_percentage >= self.threshold

        # Generate diff image (highlight differences in red)
        diff_image_path = None
        if diff_pixels > 0:
            diff_visual = current_img.copy()
            diff_visual_data = list(diff_visual.getdata())

            highlighted = []
            for i, pixel in enumerate(diff_data):
                if any(channel > tolerance for channel in pixel[:3]):
                    highlighted.append((255, 0, 0, 200))  # Red highlight
                else:
                    orig = diff_visual_data[i]
                    highlighted.append(
                        (orig[0], orig[1], orig[2], 128)
                    )  # Semi-transparent original

            diff_highlight = Image.new("RGBA", baseline_img.size)
            diff_highlight.putdata(highlighted)

            diff_filename = f"{safe_name}_diff.png"
            diff_save_path = self.diffs_dir / diff_filename
            diff_highlight.save(str(diff_save_path))
            diff_image_path = str(diff_save_path)

        return ComparisonResult(
            name=name,
            baseline_path=str(baseline_path),
            current_path=str(current_path),
            diff_image_path=diff_image_path,
            match_percentage=round(match_percentage, 2),
            diff_pixels=diff_pixels,
            passed=passed,
            threshold=self.threshold,
        )

    def list_baselines(self) -> list[BaselineInfo]:
        """List all stored baselines."""
        baselines = []
        if not self.baselines_dir.exists():
            return baselines

        for meta_file in sorted(self.baselines_dir.glob("*.json")):
            try:
                meta = json.loads(meta_file.read_text())
                png_path = meta_file.with_suffix(".png")
                if png_path.exists():
                    baselines.append(
                        BaselineInfo(
                            name=meta.get("name", meta_file.stem),
                            path=str(png_path),
                            created_at=meta.get("created_at", ""),
                            width=meta.get("width", 0),
                            height=meta.get("height", 0),
                        )
                    )
            except (json.JSONDecodeError, KeyError):
                continue

        return baselines

    def delete_baseline(self, name: str) -> bool:
        """Delete a baseline by name."""
        safe_name = _sanitize_baseline_name(name)
        png_path = self.baselines_dir / f"{safe_name}.png"
        meta_path = self.baselines_dir / f"{safe_name}.json"
        diff_path = self.diffs_dir / f"{safe_name}_diff.png"

        deleted = False
        for path in (png_path, meta_path, diff_path):
            if path.exists():
                path.unlink()
                deleted = True

        return deleted

    def get_diff_image(self, name: str) -> Path | None:
        """Get the diff image path for a given baseline name."""
        safe_name = _sanitize_baseline_name(name)
        diff_path = self.diffs_dir / f"{safe_name}_diff.png"
        return diff_path if diff_path.exists() else None
