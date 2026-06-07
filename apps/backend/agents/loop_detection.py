"""Anti-burnout loop detector for the autonomous coder.

The coder occasionally falls into a flip-flop where iteration N+2's diff
is byte-identical to iteration N (fix A breaks B → fix B reintroduces A
→ fix A breaks B again…). This burns tokens forever and never makes
progress.

This module keeps a tiny per-spec ring buffer of diff hashes and flags
the situation. The flag is **opt-in** via ``WORKPILOT_LOOP_DETECTION_ENABLED``
because some legitimate retry loops (rate-limit / auth re-prompt) can look
like flip-flops; we don't want to halt a healthy build by mistake.

Usage from ``agents/coder.py``::

    detector = get_detector(spec_dir)
    diff_hash = detector.hash_diff(project_dir)
    if detector.record_and_check(diff_hash):
        # Loop detected: emit a policy_violated event + pause the agent.
        ...

The detector is **process-local** — restarting the coder process resets
its memory. That's intentional: a flip-flop only matters within the
current run.
"""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

logger = logging.getLogger(__name__)

LOOP_DETECTION_ENV_VAR = "WORKPILOT_LOOP_DETECTION_ENABLED"

# Window size: we look for repeats within the last N hashes. A buffer of 4
# catches the simplest A↔B flip-flop (N vs N-2) and the next variant
# A→B→C→A.
_BUFFER_SIZE = 4


def loop_detection_enabled() -> bool:
    return (os.environ.get(LOOP_DETECTION_ENV_VAR, "") or "").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


@dataclass
class LoopDetector:
    """Per-spec diff-hash ring buffer.

    Public surface:
      * :meth:`hash_diff` — pure helper; returns a stable hash of
        ``git diff HEAD`` in ``project_dir``, or empty string when git
        isn't usable. Never raises.
      * :meth:`record_and_check` — append the hash, return True if the
        same hash already appears earlier in the buffer (= flip-flop).
      * :meth:`reset` — drop the buffer. Useful between unrelated specs.
    """

    spec_id: str
    _hashes: deque[str] = field(default_factory=lambda: deque(maxlen=_BUFFER_SIZE))
    _lock: Lock = field(default_factory=Lock)
    last_loop_iteration: int | None = None

    def hash_diff(self, project_dir: Path) -> str:
        """SHA-256 of ``git diff HEAD`` in ``project_dir``. Empty on failure."""
        project_dir = Path(project_dir)
        if not project_dir.is_dir():
            return ""
        try:
            proc = subprocess.run(
                ["git", "diff", "HEAD"],
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.debug("loop_detection: git diff failed: %s", exc)
            return ""
        if proc.returncode != 0:
            return ""
        # Empty diff = no progress yet, but also not a flip-flop signal —
        # treat it as "no fingerprint available" so we don't false-positive
        # at iteration 0 / 1.
        if not proc.stdout.strip():
            return ""
        return hashlib.sha256(proc.stdout.encode("utf-8")).hexdigest()

    def record_and_check(self, diff_hash: str) -> bool:
        """Append the hash; return True if we've already seen it.

        Empty hashes (= we couldn't compute a diff) are ignored, neither
        recorded nor flagged.
        """
        if not diff_hash:
            return False
        with self._lock:
            duplicate = diff_hash in self._hashes
            self._hashes.append(diff_hash)
            if duplicate:
                self.last_loop_iteration = len(self._hashes)
            return duplicate

    def reset(self) -> None:
        with self._lock:
            self._hashes.clear()
            self.last_loop_iteration = None

    def buffer_snapshot(self) -> list[str]:
        """For debugging / testing — short prefixes of the recent hashes."""
        with self._lock:
            return [h[:12] for h in self._hashes]


# ---------------------------------------------------------------------------
# Process-local registry: one detector per spec.


_REGISTRY: dict[str, LoopDetector] = {}
_REGISTRY_LOCK = Lock()


def get_detector(spec_dir: Path) -> LoopDetector:
    """Return the LoopDetector for this spec, creating it on first call."""
    spec_id = Path(spec_dir).name
    with _REGISTRY_LOCK:
        det = _REGISTRY.get(spec_id)
        if det is None:
            det = LoopDetector(spec_id=spec_id)
            _REGISTRY[spec_id] = det
        return det


def release_detector(spec_dir: Path) -> bool:
    """Drop the LoopDetector for a finished spec.

    The Electron backend is long-running and the previous code never
    evicted detectors — every spec ever opened in a session held its
    detector + history forever (small but unbounded leak).
    """
    spec_id = Path(spec_dir).name
    with _REGISTRY_LOCK:
        return _REGISTRY.pop(spec_id, None) is not None


def reset_registry_for_tests() -> None:
    """Test-only: drop the in-memory detectors so tests stay independent."""
    with _REGISTRY_LOCK:
        _REGISTRY.clear()
