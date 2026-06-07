"""Codebase Longevity Score.

Aggregates the signals collected by `tech_debt.scanner` into a single
0–100 health score plus a 6-month linear extrapolation of where the
codebase is heading.

See `scorer.py` for the public API.
"""

from .ingest import (
    SENTINEL_LATEST_SCAN_REL,
    CoverageParseError,
    load_sentinel_vulnerabilities,
    parse_coverage_xml,
)
from .scorer import (
    HealthGrade,
    LongevityProjection,
    LongevityReport,
    LongevityScorer,
    score_codebase,
    score_codebase_with_signals,
)

__all__ = [
    "CoverageParseError",
    "HealthGrade",
    "LongevityProjection",
    "LongevityReport",
    "LongevityScorer",
    "SENTINEL_LATEST_SCAN_REL",
    "load_sentinel_vulnerabilities",
    "parse_coverage_xml",
    "score_codebase",
    "score_codebase_with_signals",
]
