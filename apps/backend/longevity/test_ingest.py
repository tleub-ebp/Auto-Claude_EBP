"""Tests for the longevity ingest helpers (coverage.xml + Sentinel)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from longevity import (
    SENTINEL_LATEST_SCAN_REL,
    CoverageParseError,
    load_sentinel_vulnerabilities,
    parse_coverage_xml,
    score_codebase_with_signals,
)

# ---------------------------------------------------------------------------
# parse_coverage_xml


_VALID_ROOT_RATE = """<?xml version="1.0" ?>
<coverage line-rate="0.7423" branch-rate="0.61" version="cobertura-1.0">
  <packages/>
</coverage>
"""

_PER_PACKAGE_FALLBACK = """<?xml version="1.0" ?>
<coverage version="x">
  <packages>
    <package name="a" line-rate="0.5"/>
    <package name="b" line-rate="0.9"/>
  </packages>
</coverage>
"""

_NO_RATE_AT_ALL = """<?xml version="1.0" ?>
<coverage version="x">
  <packages><package name="a"/></packages>
</coverage>
"""


class TestParseCoverageXml:
    def test_root_line_rate(self, tmp_path: Path) -> None:
        p = tmp_path / "coverage.xml"
        p.write_text(_VALID_ROOT_RATE, encoding="utf-8")
        assert parse_coverage_xml(p) == pytest.approx(0.7423)

    def test_falls_back_to_per_package_average(self, tmp_path: Path) -> None:
        p = tmp_path / "coverage.xml"
        p.write_text(_PER_PACKAGE_FALLBACK, encoding="utf-8")
        # (0.5 + 0.9) / 2 = 0.7
        assert parse_coverage_xml(p) == pytest.approx(0.7)

    def test_clamps_above_one(self, tmp_path: Path) -> None:
        p = tmp_path / "c.xml"
        p.write_text('<coverage line-rate="1.4"/>', encoding="utf-8")
        assert parse_coverage_xml(p) == 1.0

    def test_clamps_below_zero(self, tmp_path: Path) -> None:
        p = tmp_path / "c.xml"
        p.write_text('<coverage line-rate="-0.5"/>', encoding="utf-8")
        assert parse_coverage_xml(p) == 0.0

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(CoverageParseError, match="not found"):
            parse_coverage_xml(tmp_path / "ghost.xml")

    def test_invalid_xml_raises(self, tmp_path: Path) -> None:
        p = tmp_path / "c.xml"
        p.write_text("not xml", encoding="utf-8")
        with pytest.raises(CoverageParseError, match="invalid XML"):
            parse_coverage_xml(p)

    def test_no_rate_at_all_raises(self, tmp_path: Path) -> None:
        p = tmp_path / "c.xml"
        p.write_text(_NO_RATE_AT_ALL, encoding="utf-8")
        with pytest.raises(CoverageParseError):
            parse_coverage_xml(p)

    def test_non_numeric_rate_raises(self, tmp_path: Path) -> None:
        p = tmp_path / "c.xml"
        p.write_text('<coverage line-rate="oops"/>', encoding="utf-8")
        with pytest.raises(CoverageParseError, match="non-numeric"):
            parse_coverage_xml(p)


# ---------------------------------------------------------------------------
# load_sentinel_vulnerabilities


def _seed_sentinel(project_dir: Path, vulns: list[dict]) -> None:
    snapshot = project_dir / SENTINEL_LATEST_SCAN_REL
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_text(
        json.dumps({"scanned_at": 0, "vulnerabilities": vulns}),
        encoding="utf-8",
    )


class TestLoadSentinelVulnerabilities:
    def test_no_snapshot_returns_empty(self, tmp_path: Path) -> None:
        assert load_sentinel_vulnerabilities(tmp_path) == []

    def test_reads_normalised_vulns(self, tmp_path: Path) -> None:
        _seed_sentinel(
            tmp_path,
            [
                {
                    "package": "lodash",
                    "current_version": "4.17.10",
                    "severity": "high",
                    "advisory": "GHSA-x",
                    "fixed_in": "4.17.20",
                },
                {"package": "x", "severity": "critical"},
            ],
        )
        loaded = load_sentinel_vulnerabilities(tmp_path)
        assert len(loaded) == 2
        assert loaded[0]["severity"] == "high"
        assert loaded[0]["package"] == "lodash"
        assert loaded[1]["severity"] == "critical"

    def test_missing_severity_defaults_to_low(self, tmp_path: Path) -> None:
        _seed_sentinel(tmp_path, [{"package": "x"}])
        loaded = load_sentinel_vulnerabilities(tmp_path)
        assert loaded[0]["severity"] == "low"

    def test_malformed_json_returns_empty(self, tmp_path: Path) -> None:
        snapshot = tmp_path / SENTINEL_LATEST_SCAN_REL
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        snapshot.write_text("not json", encoding="utf-8")
        assert load_sentinel_vulnerabilities(tmp_path) == []

    def test_drops_non_dict_entries(self, tmp_path: Path) -> None:
        _seed_sentinel(tmp_path, ["bad", {"severity": "high"}])  # type: ignore[list-item]
        loaded = load_sentinel_vulnerabilities(tmp_path)
        assert len(loaded) == 1
        assert loaded[0]["severity"] == "high"


# ---------------------------------------------------------------------------
# score_codebase_with_signals — integration


def _seed_minimal_project(root: Path) -> None:
    """Write enough structure that the debt scanner finds something."""
    (root / "src").mkdir()
    (root / "src" / "main.py").write_text(
        "# TODO: refactor\ndef foo():\n    pass\n",
        encoding="utf-8",
    )


class TestScoreCodebaseWithSignals:
    def test_no_signals_passes_none(self, tmp_path: Path) -> None:
        _seed_minimal_project(tmp_path)
        report = score_codebase_with_signals(tmp_path, auto_load_sentinel=False)
        # No coverage/vuln signal → those keys absent from summary.
        assert "coverage_ratio" not in report.summary
        assert "vulnerabilities" not in report.summary

    def test_coverage_signal_lowers_score(self, tmp_path: Path) -> None:
        _seed_minimal_project(tmp_path)
        coverage = tmp_path / "coverage.xml"
        coverage.write_text('<coverage line-rate="0.10"/>', encoding="utf-8")
        with_cov = score_codebase_with_signals(
            tmp_path,
            coverage_xml=coverage,
            auto_load_sentinel=False,
        )
        without_cov = score_codebase_with_signals(tmp_path, auto_load_sentinel=False)
        # 10% coverage ramps the penalty close to its maximum.
        assert with_cov.score < without_cov.score
        assert "coverage_ratio" in with_cov.summary
        assert with_cov.summary["coverage_ratio"] == pytest.approx(0.10, abs=0.01)

    def test_sentinel_signal_lowers_score_when_critical(self, tmp_path: Path) -> None:
        _seed_minimal_project(tmp_path)
        _seed_sentinel(
            tmp_path,
            [{"severity": "critical", "package": "evil"} for _ in range(3)],
        )
        with_vulns = score_codebase_with_signals(tmp_path, auto_load_sentinel=True)
        # Snapshot present + 3 criticals → vulns block in summary.
        assert "vulnerabilities" in with_vulns.summary
        assert with_vulns.summary["vulnerabilities"]["total"] == 3
        # Score should be lower than the unsignalled baseline.
        baseline = score_codebase_with_signals(tmp_path, auto_load_sentinel=False)
        assert with_vulns.score < baseline.score

    def test_empty_sentinel_snapshot_signals_clean(self, tmp_path: Path) -> None:
        _seed_minimal_project(tmp_path)
        _seed_sentinel(tmp_path, [])
        report = score_codebase_with_signals(tmp_path, auto_load_sentinel=True)
        # Snapshot present but empty → vulns block exists, total=0.
        assert "vulnerabilities" in report.summary
        assert report.summary["vulnerabilities"]["total"] == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
