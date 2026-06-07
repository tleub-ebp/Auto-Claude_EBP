"""Pre-commit hooks for WorkPilot AI features.

Three opt-in checks invocable as a single CLI command:

* ``license-check``   — fails on policy violations from the License Scanner
* ``drift-check``     — fails on HIGH/CRITICAL architecture drift vs baseline
* ``gen-tests-check`` — fails on regressions vs the latest test generation

Install manually in ``.git/hooks/pre-commit`` (or via your hook manager
of choice — pre-commit, husky, lefthook). All checks are designed to be
fast (parse-only — they don't run the full scanner unless asked) and to
exit cleanly when their input data is missing (no spurious failures on
fresh checkouts).
"""

from .precommit import (
    HOOK_EXIT_INFRASTRUCTURE_ERROR,
    HOOK_EXIT_OK,
    HOOK_EXIT_VIOLATION,
    main,
    run_attribution_update,
    run_drift_check,
    run_gen_tests_check,
    run_license_check,
)

__all__ = [
    "HOOK_EXIT_INFRASTRUCTURE_ERROR",
    "HOOK_EXIT_OK",
    "HOOK_EXIT_VIOLATION",
    "main",
    "run_attribution_update",
    "run_drift_check",
    "run_gen_tests_check",
    "run_license_check",
]
