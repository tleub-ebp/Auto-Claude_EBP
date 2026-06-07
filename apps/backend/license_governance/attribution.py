"""Generate ATTRIBUTION.md from a LicenseReport.

Produces an OSS attribution document grouped by license category, with one
row per dependency. The output is **deterministic** (sorted by ecosystem →
license → name) so it can be diffed safely in CI and committed to the
repo.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .scanner import (
    DependencyRecord,
    LicenseCategory,
    LicenseReport,
    classify_license,
)

UNKNOWN_LABEL = "Unknown"
ATTRIBUTION_FILENAME = "ATTRIBUTION.md"


@dataclass
class AttributionOptions:
    project_name: str = "this project"
    include_transitive: bool = True
    include_unknown: bool = True
    timestamp: datetime | None = None  # If None, uses utcnow at render time.


def _category_heading(category: LicenseCategory) -> str:
    return {
        LicenseCategory.PERMISSIVE: "Permissive licenses",
        LicenseCategory.PUBLIC_DOMAIN: "Public domain / unrestricted",
        LicenseCategory.WEAK_COPYLEFT: "Weak copyleft (LGPL-style)",
        LicenseCategory.STRONG_COPYLEFT: "Strong copyleft (GPL-style)",
        LicenseCategory.NETWORK_COPYLEFT: "Network copyleft (AGPL-style)",
        LicenseCategory.COMMERCIAL: "Commercial / proprietary",
        LicenseCategory.UNKNOWN: "Unclassified",
    }.get(category, str(category.value))


def _license_label(dep: DependencyRecord) -> str:
    """Display label for a dep — the declared license, or Unknown."""
    return (dep.declared_license or "").strip() or UNKNOWN_LABEL


def render_attribution(
    report: LicenseReport, options: AttributionOptions | None = None
) -> str:
    """Render an ATTRIBUTION.md body from a scan report."""
    opts = options or AttributionOptions()

    deps = list(report.dependencies)
    if not opts.include_transitive:
        deps = [d for d in deps if d.is_direct]
    if not opts.include_unknown:
        deps = [
            d
            for d in deps
            if classify_license(d.declared_license) is not LicenseCategory.UNKNOWN
        ]

    # Group: category → ecosystem → list[dep]. Each level sorted.
    by_category: dict[LicenseCategory, dict[str, list[DependencyRecord]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for dep in deps:
        category = classify_license(dep.declared_license)
        by_category[category][dep.ecosystem].append(dep)

    when = (opts.timestamp or datetime.now(timezone.utc)).strftime("%Y-%m-%d")

    lines: list[str] = [
        f"# Third-party attributions for {opts.project_name}",
        "",
        f"_Generated on {when} from {len(deps)} tracked dependencies "
        f"({_count_direct(deps)} direct, {len(deps) - _count_direct(deps)} transitive)._",
        "",
        "This document lists every third-party dependency bundled or runtime-required "
        "by this project, grouped by license category. Re-generate with the License "
        "Governance scanner; do not edit by hand.",
        "",
    ]

    # Stable category order: permissive first, copyleft, then proprietary/unknown.
    category_order = [
        LicenseCategory.PERMISSIVE,
        LicenseCategory.PUBLIC_DOMAIN,
        LicenseCategory.WEAK_COPYLEFT,
        LicenseCategory.STRONG_COPYLEFT,
        LicenseCategory.NETWORK_COPYLEFT,
        LicenseCategory.COMMERCIAL,
        LicenseCategory.UNKNOWN,
    ]

    for category in category_order:
        if category not in by_category:
            continue
        ecosystems = by_category[category]
        total = sum(len(v) for v in ecosystems.values())
        lines.append(f"## {_category_heading(category)} ({total})")
        lines.append("")
        for ecosystem in sorted(ecosystems):
            ordered = sorted(
                ecosystems[ecosystem],
                key=lambda d: (_license_label(d).lower(), d.name.lower()),
            )
            lines.append(f"### {ecosystem}")
            lines.append("")
            lines.append("| Package | Version | License | Direct? |")
            lines.append("|---|---|---|---|")
            for dep in ordered:
                lines.append(
                    f"| {dep.name} | {dep.version or '—'} | "
                    f"{_license_label(dep)} | "
                    f"{'yes' if dep.is_direct else 'no'} |"
                )
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def write_attribution(
    report: LicenseReport,
    project_root: Path,
    options: AttributionOptions | None = None,
) -> Path:
    """Render and write ``ATTRIBUTION.md`` at the project root.

    Returns the written path so callers can log it / pass it to git add.
    """
    target = project_root / ATTRIBUTION_FILENAME
    target.write_text(render_attribution(report, options), encoding="utf-8")
    return target


def _count_direct(deps: list[DependencyRecord]) -> int:
    return sum(1 for d in deps if d.is_direct)
