"""
Browser Controller
===================

Playwright-based browser controller for the Built-in Browser Agent.
Provides async API for browser automation: navigation, screenshots, interaction.
"""

import logging
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any

from ._naming import safe_artifact_path
from .models import ScreenshotInfo

logger = logging.getLogger(__name__)

# Cap on captured console messages — pages with chatty consoles (ad
# scripts, dev warnings) used to grow `_console_errors` unboundedly during
# long sessions, eating RAM and making `get_console_errors()` slow.
_MAX_CONSOLE_ERRORS = 1000


class BrowserController:
    """Headless Chromium browser controller using Playwright."""

    def __init__(self, project_dir: Path, headless: bool = True):
        self.project_dir = Path(project_dir)
        self.headless = headless
        self.screenshots_dir = (
            self.project_dir / ".workpilot" / "browser-agent" / "screenshots"
        )
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)

        self._playwright = None
        self._browser = None
        self._page = None
        # Bounded deque, not list — pages with chatty consoles previously
        # leaked unbounded memory across long sessions.
        self._console_errors: deque[str] = deque(maxlen=_MAX_CONSOLE_ERRORS)

    async def launch(self) -> None:
        """Launch a headless Chromium browser.

        Cleans up partial state on any failure: previously a launch that
        succeeded `chromium.launch()` but failed `new_page()` left the
        browser + playwright drivers running, so repeated failed launches
        accumulated zombie chromium processes until fds were exhausted.
        """
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError(
                "playwright is not installed. Run: pip install playwright && playwright install chromium"
            )

        try:
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=self.headless
            )
            self._page = await self._browser.new_page()
        except Exception:
            # Tear down whatever did succeed before re-raising.
            await self.close()
            raise

        # Capture console errors
        self._console_errors.clear()
        self._page.on(
            "console",
            lambda msg: (
                self._console_errors.append(f"[{msg.type}] {msg.text}")
                if msg.type in ("error", "warning")
                else None
            ),
        )

    async def navigate(self, url: str, wait_until: str = "networkidle") -> dict:
        """Navigate to a URL and return page info."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")

        response = await self._page.goto(url, wait_until=wait_until, timeout=30000)
        title = await self._page.title()

        return {
            "url": self._page.url,
            "title": title,
            "status": response.status if response else None,
        }

    async def screenshot(
        self, name: str, full_page: bool = False, url: str | None = None
    ) -> ScreenshotInfo:
        """Capture a screenshot and save it to the screenshots directory."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")

        if url:
            await self.navigate(url)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        # Sanitize aggressively: `name` may originate from an LLM tool call.
        filepath = safe_artifact_path(
            self.screenshots_dir,
            name,
            f"_{timestamp}.png",
            fallback="screenshot",
        )

        await self._page.screenshot(path=str(filepath), full_page=full_page)

        # Get viewport size
        viewport = self._page.viewport_size or {"width": 1280, "height": 720}

        return ScreenshotInfo(
            name=name,
            path=str(filepath),
            url=self._page.url,
            timestamp=datetime.now().isoformat(),
            width=viewport["width"],
            height=viewport["height"],
        )

    async def click(self, selector: str) -> None:
        """Click an element by CSS selector."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")
        await self._page.click(selector, timeout=10000)

    async def fill(self, selector: str, value: str) -> None:
        """Fill an input element by CSS selector."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")
        await self._page.fill(selector, value, timeout=10000)

    async def evaluate(self, script: str) -> Any:
        """Execute JavaScript in the browser context.

        SECURITY: this method runs arbitrary JS with full page privileges
        (cookies, localStorage, fetch to internal services). When `script`
        originates from an LLM tool call influenced by remote page content,
        an attacker controlling page text could inject JS to exfiltrate
        auth tokens. We audit-log every call so the abuse trail exists; a
        future hardening should restrict to an allowlist of pre-defined
        snippets.
        """
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")
        # Truncate the script in logs to keep log size bounded but still
        # preserve enough of the snippet to investigate suspicious calls.
        logger.warning(
            "browser_agent.evaluate called on %s (script[:200]=%r)",
            self._page.url,
            script[:200],
        )
        return await self._page.evaluate(script)

    async def get_console_errors(self) -> list[str]:
        """Return captured console errors and warnings (capped at MAX)."""
        return list(self._console_errors)

    async def clear_console_errors(self) -> None:
        """Reset the captured console-error buffer."""
        self._console_errors.clear()

    async def get_page_html(self) -> str:
        """Return the current page HTML content."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")
        return await self._page.content()

    async def get_page_title(self) -> str:
        """Return the current page title."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")
        return await self._page.title()

    async def set_viewport(self, width: int, height: int) -> None:
        """Set the browser viewport size."""
        if not self._page:
            raise RuntimeError("Browser not launched. Call launch() first.")
        await self._page.set_viewport_size({"width": width, "height": height})

    async def close(self) -> None:
        """Close the browser and cleanup resources."""
        if self._page:
            await self._page.close()
            self._page = None
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None

    def list_screenshots(self) -> list[ScreenshotInfo]:
        """List all captured screenshots."""
        screenshots = []
        if not self.screenshots_dir.exists():
            return screenshots

        for f in sorted(
            self.screenshots_dir.glob("*.png"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            try:
                from PIL import Image

                with Image.open(f) as img:
                    w, h = img.size
            except Exception:
                w, h = 0, 0

            # Extract name from filename (remove timestamp suffix)
            parts = f.stem.rsplit("_", 2)
            name = parts[0] if len(parts) >= 3 else f.stem

            screenshots.append(
                ScreenshotInfo(
                    name=name,
                    path=str(f),
                    url="",
                    timestamp=datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                    width=w,
                    height=h,
                )
            )

        return screenshots
