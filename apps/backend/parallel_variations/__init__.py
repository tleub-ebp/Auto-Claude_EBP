"""Local Arena: scaffold N parallel variations of the same spec.

The user can ask for the same feature to be built N times by the
autonomous pipeline (different seeds / models / prompts) and then
compare the resulting diffs side by side. The merge is **always
manual** — the user picks the winner via the UI; we never auto-merge.

This module is **read/write but conservative**: it creates copies of
the spec into ``<spec>/variations/<label>/`` and offers a comparison
helper. It does NOT spawn agents, does NOT touch git, does NOT merge.

Configuration:
  * ``WORKPILOT_PARALLEL_VARIATIONS`` (int 1-5, default 1)
    The maximum number of variations create_variations() will scaffold
    in one call. Set to ``1`` (default) effectively keeps the feature
    OFF in the UI — the existing single-build path is the only option.
"""

from .planner import (
    DEFAULT_MAX_VARIATIONS,
    PARALLEL_VARIATIONS_ENV_VAR,
    VariationComparison,
    VariationDescriptor,
    VariationManifest,
    compare_variations,
    create_variations,
    list_variations,
    parallel_variations_limit,
)

__all__ = [
    "DEFAULT_MAX_VARIATIONS",
    "PARALLEL_VARIATIONS_ENV_VAR",
    "VariationComparison",
    "VariationDescriptor",
    "VariationManifest",
    "compare_variations",
    "create_variations",
    "list_variations",
    "parallel_variations_limit",
]
