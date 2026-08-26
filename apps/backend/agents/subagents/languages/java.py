"""Java / Kotlin overlay."""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="java",
    test_commands=[
        "mvn -q test                     # Maven",
        "gradle test --console=plain     # Gradle",
        "mvn -q test -Dtest=ClassName#method",
    ],
    lint_commands=["mvn -q verify -DskipTests", "gradle check -x test"],
    notes=(
        "Pick the build tool from what is on disk (pom.xml vs build.gradle[.kts]); "
        "running the wrong one fails in a way that looks like a missing dependency. "
        "Surefire writes the real failure to target/surefire-reports/."
    ),
)
