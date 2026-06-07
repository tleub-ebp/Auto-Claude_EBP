"""Tests for the ATTRIBUTION.md generator."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from license_governance import (
    ATTRIBUTION_FILENAME,
    AttributionOptions,
    DependencyRecord,
    LicenseReport,
    render_attribution,
    write_attribution,
)


def _make_report(*deps: DependencyRecord) -> LicenseReport:
    return LicenseReport(dependencies=list(deps))


_FIXED_TIMESTAMP = datetime(2026, 4, 28, tzinfo=timezone.utc)


def _opts(**overrides) -> AttributionOptions:
    base = AttributionOptions(
        project_name="demo",
        timestamp=_FIXED_TIMESTAMP,
    )
    for k, v in overrides.items():
        setattr(base, k, v)
    return base


# ---------------------------------------------------------------------------
# Header / structure


class TestHeader:
    def test_includes_project_name_and_date(self) -> None:
        out = render_attribution(_make_report(), _opts())
        assert "demo" in out
        assert "2026-04-28" in out

    def test_counts_direct_vs_transitive(self) -> None:
        out = render_attribution(
            _make_report(
                DependencyRecord(
                    name="a",
                    version="1",
                    ecosystem="npm",
                    declared_license="MIT",
                    is_direct=True,
                ),
                DependencyRecord(
                    name="b",
                    version="1",
                    ecosystem="npm",
                    declared_license="MIT",
                    is_direct=False,
                ),
            ),
            _opts(),
        )
        assert "2 tracked dependencies" in out
        assert "(1 direct, 1 transitive)" in out


# ---------------------------------------------------------------------------
# Grouping by category + ecosystem


class TestGrouping:
    def test_groups_by_category_then_ecosystem(self) -> None:
        deps = [
            DependencyRecord("react", "18", "npm", "MIT"),
            DependencyRecord("requests", "2.31", "pypi", "Apache-2.0"),
            DependencyRecord("readline", "8", "npm", "GPL-3.0"),
        ]
        out = render_attribution(_make_report(*deps), _opts())
        assert "## Permissive licenses" in out
        assert "## Strong copyleft (GPL-style)" in out
        # Ecosystem subheaders.
        assert "### npm" in out
        assert "### pypi" in out
        # Permissive section comes before copyleft.
        assert out.index("Permissive licenses") < out.index("Strong copyleft")

    def test_unknown_category_renders_under_unclassified(self) -> None:
        out = render_attribution(
            _make_report(
                DependencyRecord("mystery-pkg", "0.1", "npm", declared_license=None)
            ),
            _opts(),
        )
        assert "## Unclassified" in out
        # The literal "Unknown" label appears in the License column.
        assert "Unknown" in out

    def test_can_omit_unknowns(self) -> None:
        out = render_attribution(
            _make_report(
                DependencyRecord("ok", "1", "npm", "MIT"),
                DependencyRecord("mystery", "0.1", "npm", None),
            ),
            _opts(include_unknown=False),
        )
        assert "## Unclassified" not in out
        assert "mystery" not in out

    def test_can_omit_transitive(self) -> None:
        out = render_attribution(
            _make_report(
                DependencyRecord("direct", "1", "npm", "MIT", is_direct=True),
                DependencyRecord("indirect", "1", "npm", "MIT", is_direct=False),
            ),
            _opts(include_transitive=False),
        )
        assert "direct" in out
        assert "indirect" not in out


# ---------------------------------------------------------------------------
# Determinism / sorting (so the file diffs cleanly across CI runs)


class TestDeterminism:
    def test_output_is_byte_identical_across_runs(self) -> None:
        deps = [
            DependencyRecord("zeta", "1", "npm", "MIT"),
            DependencyRecord("alpha", "2", "npm", "MIT"),
            DependencyRecord("beta", "3", "pypi", "Apache-2.0"),
        ]
        a = render_attribution(_make_report(*deps), _opts())
        b = render_attribution(_make_report(*deps), _opts())
        assert a == b

    def test_packages_sorted_alphabetically_within_ecosystem(self) -> None:
        deps = [
            DependencyRecord("zeta", "1", "npm", "MIT"),
            DependencyRecord("alpha", "1", "npm", "MIT"),
            DependencyRecord("mu", "1", "npm", "MIT"),
        ]
        out = render_attribution(_make_report(*deps), _opts())
        npm_section = out.split("### npm", 1)[1]
        # alpha must appear before mu, mu before zeta.
        assert (
            npm_section.index("alpha")
            < npm_section.index("mu")
            < npm_section.index("zeta")
        )


# ---------------------------------------------------------------------------
# write_attribution


class TestWriteToDisk:
    def test_writes_attribution_file_at_project_root(self, tmp_path: Path) -> None:
        report = _make_report(
            DependencyRecord("react", "18", "npm", "MIT"),
        )
        written = write_attribution(report, tmp_path, _opts())
        assert written == tmp_path / ATTRIBUTION_FILENAME
        assert written.exists()
        content = written.read_text(encoding="utf-8")
        assert "react" in content
        assert "MIT" in content


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
