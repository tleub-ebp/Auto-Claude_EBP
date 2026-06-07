"""Regression test for the RateLimiter singleton thread-safety fix.

Pre-fix: `get_instance()` performed a non-atomic check-then-create which
allowed two threads racing into bootstrap to create two RateLimiter
objects, each with its own token bucket — effectively doubling the
allowed request rate.

Post-fix: double-checked locking guarantees a single instance even
under concurrent first-time access.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from runners.github.rate_limiter import RateLimiter  # noqa: E402


class TestRateLimiterSingleton:
    def setup_method(self) -> None:
        # Reset class state so each test starts clean.
        RateLimiter._instance = None
        RateLimiter._initialized = False

    def teardown_method(self) -> None:
        RateLimiter._instance = None
        RateLimiter._initialized = False

    def test_get_instance_returns_same_object(self) -> None:
        a = RateLimiter.get_instance()
        b = RateLimiter.get_instance()
        assert a is b

    def test_concurrent_get_instance_returns_same_object(self) -> None:
        """Race-condition regression: 32 threads racing into bootstrap
        must all see the SAME RateLimiter instance."""
        instances: list[RateLimiter] = []
        lock = threading.Lock()
        barrier = threading.Barrier(32)

        def worker() -> None:
            # All threads sync at the barrier so they hit get_instance
            # at (nearly) the same moment, maximizing the race window.
            barrier.wait()
            inst = RateLimiter.get_instance()
            with lock:
                instances.append(inst)

        threads = [threading.Thread(target=worker) for _ in range(32)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(instances) == 32
        first = instances[0]
        for other in instances[1:]:
            assert other is first, (
                "RateLimiter singleton race detected: at least one thread "
                "got a different instance — token-bucket state is split."
            )

    def test_lock_attribute_exists(self) -> None:
        # Defensive sanity check: the fix introduced _instance_lock.
        assert isinstance(RateLimiter._instance_lock, type(threading.Lock()))
