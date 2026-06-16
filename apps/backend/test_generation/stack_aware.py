"""
Stack-aware automatic test planning.

Given the files a kanban subtask touches, decide which kinds of automated
tests the coding agent must produce — API contract tests, WinForms UI tests,
web E2E tests or plain unit tests — based on the stack and the test libraries
actually installed in the target project (csproj/packages.config,
package.json, requirements/pyproject). The output is a markdown section
injected into the subtask coding prompt, so the agent writes the right tests
with the right framework instead of inventing dependencies the project does
not have.

Disabled with AUTO_TEST_GENERATION=false.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

# Directories never worth scanning for project/manifest files.
_SKIP_DIRS = {
    "node_modules",
    "bin",
    "obj",
    "dist",
    "build",
    ".git",
    ".workpilot",
    ".worktrees",
    "packages",
    "__pycache__",
    ".venv",
    "venv",
}

# Cap filesystem walking on huge repositories.
_MAX_PROJECT_FILES = 40


@dataclass
class StackProfile:
    """Test-relevant technologies detected in the target project."""

    # .NET
    dotnet: bool = False
    winforms: bool = False
    aspnet: bool = False
    dotnet_test_framework: str | None = None  # xUnit | NUnit | MSTest
    winforms_ui_test_lib: str | None = None  # FlaUI | TestStack.White | WinAppDriver
    # Node / web
    node: bool = False
    js_test_framework: str | None = None  # vitest | jest | mocha
    e2e_framework: str | None = None  # Playwright | Cypress
    web_framework: str | None = None  # React | Vue | Angular | Svelte
    node_api_framework: str | None = None  # Express | Fastify | NestJS | Koa
    # Python
    python: bool = False
    python_test_framework: str | None = None  # pytest | unittest
    python_api_framework: str | None = None  # FastAPI | Flask | Django


def _iter_project_files(project_dir: Path, patterns: tuple[str, ...]) -> list[Path]:
    """Walk the project for manifest files, skipping vendored/build dirs."""
    found: list[Path] = []
    stack = [project_dir]
    while stack and len(found) < _MAX_PROJECT_FILES:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir():
                if entry.name.lower() not in _SKIP_DIRS and not entry.name.startswith(
                    "."
                ):
                    stack.append(entry)
            elif any(entry.match(p) for p in patterns):
                found.append(entry)
                if len(found) >= _MAX_PROJECT_FILES:
                    break
    return found


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _detect_dotnet(project_dir: Path, profile: StackProfile) -> None:
    manifests = _iter_project_files(project_dir, ("*.csproj", "packages.config"))
    if not manifests:
        return
    profile.dotnet = True
    blob = "\n".join(_read(m) for m in manifests)
    lower = blob.lower()

    if "<usewindowsforms>true" in lower or "system.windows.forms" in lower:
        profile.winforms = True
    if (
        "microsoft.aspnetcore" in lower
        or '<project sdk="microsoft.net.sdk.web"' in lower
    ):
        profile.aspnet = True

    if "xunit" in lower:
        profile.dotnet_test_framework = "xUnit"
    elif "nunit" in lower:
        profile.dotnet_test_framework = "NUnit"
    elif "mstest" in lower or "microsoft.visualstudio.testtools" in lower:
        profile.dotnet_test_framework = "MSTest"

    if "flaui" in lower:
        profile.winforms_ui_test_lib = "FlaUI"
    elif "teststack.white" in lower:
        profile.winforms_ui_test_lib = "TestStack.White"
    elif "winappdriver" in lower or "appium" in lower:
        profile.winforms_ui_test_lib = "WinAppDriver"


def _detect_node(project_dir: Path, profile: StackProfile) -> None:
    package_json = project_dir / "package.json"
    deps: dict[str, str] = {}
    candidates = [package_json]
    # Light monorepo support: apps/* and packages/* one level down.
    for sub in ("apps", "packages"):
        sub_dir = project_dir / sub
        if sub_dir.is_dir():
            try:
                candidates.extend(
                    child / "package.json"
                    for child in sorted(sub_dir.iterdir())
                    if child.is_dir()
                )
            except OSError:
                pass
    for candidate in candidates[:10]:
        if not candidate.is_file():
            continue
        try:
            data = json.loads(_read(candidate) or "{}")
        except json.JSONDecodeError:
            continue
        for key in ("dependencies", "devDependencies"):
            value = data.get(key)
            if isinstance(value, dict):
                deps.update(value)

    if not deps:
        return
    profile.node = True

    if "vitest" in deps:
        profile.js_test_framework = "vitest"
    elif "jest" in deps:
        profile.js_test_framework = "jest"
    elif "mocha" in deps:
        profile.js_test_framework = "mocha"

    if "@playwright/test" in deps or "playwright" in deps:
        profile.e2e_framework = "Playwright"
    elif "cypress" in deps:
        profile.e2e_framework = "Cypress"

    if "react" in deps:
        profile.web_framework = "React"
    elif "vue" in deps:
        profile.web_framework = "Vue"
    elif "@angular/core" in deps:
        profile.web_framework = "Angular"
    elif "svelte" in deps:
        profile.web_framework = "Svelte"

    if "@nestjs/core" in deps:
        profile.node_api_framework = "NestJS"
    elif "fastify" in deps:
        profile.node_api_framework = "Fastify"
    elif "express" in deps:
        profile.node_api_framework = "Express"
    elif "koa" in deps:
        profile.node_api_framework = "Koa"


def _detect_python(project_dir: Path, profile: StackProfile) -> None:
    blob = ""
    for name in (
        "requirements.txt",
        "requirements-dev.txt",
        "pyproject.toml",
        "Pipfile",
    ):
        candidate = project_dir / name
        if candidate.is_file():
            blob += "\n" + _read(candidate)
    if not blob.strip():
        return
    lower = blob.lower()
    profile.python = True

    if "pytest" in lower:
        profile.python_test_framework = "pytest"

    if "fastapi" in lower:
        profile.python_api_framework = "FastAPI"
    elif "flask" in lower:
        profile.python_api_framework = "Flask"
    elif "django" in lower:
        profile.python_api_framework = "Django"


def detect_stack(project_dir: Path | str) -> StackProfile:
    """Detect the test-relevant stack of a project from its manifests."""
    project_dir = Path(project_dir)
    profile = StackProfile()
    if not project_dir.is_dir():
        return profile
    _detect_dotnet(project_dir, profile)
    _detect_node(project_dir, profile)
    _detect_python(project_dir, profile)
    return profile


# ---------------------------------------------------------------------------
# File classification
# ---------------------------------------------------------------------------

# Test kinds, in display order.
KIND_API = "api"
KIND_WINFORMS = "winforms_ui"
KIND_WEB = "web_ui"
KIND_UNIT = "unit"

_CODE_EXTENSIONS = {
    ".cs",
    ".vb",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".vue",
    ".svelte",
    ".py",
}

_API_PATH_HINTS = re.compile(
    r"(controller|/api/|\\api\\|route|endpoint|router|views\.py|handlers?)", re.I
)
_WINFORMS_NAME_HINTS = re.compile(r"(form|usercontrol|frm[A-Z_]|dlg[A-Z_])", re.I)
_WEB_PATH_HINTS = re.compile(r"(component|page|view|screen|renderer|/ui/|\\ui\\)", re.I)


def classify_file(file_path: str, profile: StackProfile) -> str | None:
    """Classify a touched file into the kind of automated test it calls for.

    Returns one of KIND_API / KIND_WINFORMS / KIND_WEB / KIND_UNIT, or None
    for files that don't warrant tests (config, docs, assets, generated code).
    """
    normalized = file_path.replace("\\", "/")
    suffix = Path(normalized).suffix.lower()
    name = Path(normalized).name

    if suffix not in _CODE_EXTENSIONS:
        return None
    # Generated WinForms designer files and existing tests don't need new tests.
    if name.lower().endswith(".designer.cs"):
        return None
    lowered = normalized.lower()
    if "test" in name.lower() or "/tests/" in lowered or "__tests__" in lowered:
        return None

    if suffix in {".cs", ".vb"}:
        if _API_PATH_HINTS.search(normalized) and (
            profile.aspnet or not profile.winforms
        ):
            return KIND_API
        if profile.winforms and _WINFORMS_NAME_HINTS.search(name):
            return KIND_WINFORMS
        return KIND_UNIT

    if suffix in {".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"}:
        if profile.node_api_framework and _API_PATH_HINTS.search(normalized):
            return KIND_API
        if suffix in {".tsx", ".jsx", ".vue", ".svelte"} or _WEB_PATH_HINTS.search(
            normalized
        ):
            return KIND_WEB
        return KIND_UNIT

    if suffix == ".py":
        if profile.python_api_framework and _API_PATH_HINTS.search(normalized):
            return KIND_API
        return KIND_UNIT

    return KIND_UNIT


# ---------------------------------------------------------------------------
# Instruction building
# ---------------------------------------------------------------------------


def _api_instructions(profile: StackProfile, files: list[str]) -> list[str]:
    lines = ["**API contract tests** for:"]
    lines.extend(f"- `{f}`" for f in files)
    if profile.aspnet and profile.dotnet_test_framework:
        lines.append(
            f"  Use {profile.dotnet_test_framework} with `WebApplicationFactory`/`HttpClient`: "
            "one test per endpoint touched (nominal status code + response shape, "
            "plus the main error case such as 400/404)."
        )
    elif profile.python_api_framework == "FastAPI":
        lines.append(
            "  Use pytest with FastAPI's `TestClient`: assert status codes and "
            "response schemas for each route touched."
        )
    elif profile.python_api_framework:
        lines.append(
            f"  Use {profile.python_test_framework or 'the project test runner'} with "
            f"{profile.python_api_framework}'s test client: assert status codes and "
            "response payloads for each route touched."
        )
    elif profile.node_api_framework:
        runner = profile.js_test_framework or "the project test runner"
        lines.append(
            f"  Use {runner} + supertest (only if already installed) against the "
            f"{profile.node_api_framework} app: assert status codes and response "
            "bodies for each route touched."
        )
    else:
        lines.append(
            "  Cover each endpoint's contract (status code + payload shape) with the "
            "test framework already present in the project."
        )
    return lines


def _winforms_instructions(profile: StackProfile, files: list[str]) -> list[str]:
    lines = ["**WinForms UI tests** for:"]
    lines.extend(f"- `{f}`" for f in files)
    if profile.winforms_ui_test_lib:
        lines.append(
            f"  Use {profile.winforms_ui_test_lib} (already referenced by the project) "
            "to automate the form: launch, exercise the main user action of this "
            "subtask, assert the visible result."
        )
    else:
        lines.append(
            "  No WinForms UI automation library is installed — do NOT add one. "
            "Instead, extract the form's logic into testable methods (presenter/"
            "service) and unit-test those with "
            f"{profile.dotnet_test_framework or 'the project test framework'}."
        )
    return lines


def _web_instructions(profile: StackProfile, files: list[str]) -> list[str]:
    lines = ["**Web E2E / component tests** for:"]
    lines.extend(f"- `{f}`" for f in files)
    if profile.e2e_framework:
        lines.append(
            f"  Add or extend a {profile.e2e_framework} scenario covering the user "
            "flow this subtask changes (happy path + the visible error state)."
        )
    elif profile.js_test_framework:
        lines.append(
            f"  No E2E framework installed — write {profile.js_test_framework} "
            "component tests instead (render, interact, assert), without adding "
            "new dependencies."
        )
    else:
        lines.append(
            "  No JS test framework detected — cover the underlying logic with the "
            "project's existing test setup if any, and note untested UI in the PR."
        )
    return lines


def _unit_instructions(profile: StackProfile, files: list[str]) -> list[str]:
    frameworks = [
        f
        for f in (
            profile.dotnet_test_framework,
            profile.js_test_framework,
            profile.python_test_framework,
        )
        if f
    ]
    lines = ["**Unit tests** for:"]
    lines.extend(f"- `{f}`" for f in files)
    if frameworks:
        lines.append(
            f"  Use {', '.join(frameworks)} (as appropriate per language): cover the "
            "new/changed behavior, including at least one edge case."
        )
    else:
        lines.append(
            "  Use the project's existing test conventions; if none exist, create "
            "minimal tests following the language's standard runner."
        )
    return lines


_BUILDERS = {
    KIND_API: _api_instructions,
    KIND_WINFORMS: _winforms_instructions,
    KIND_WEB: _web_instructions,
    KIND_UNIT: _unit_instructions,
}


def build_auto_test_instructions(
    project_dir: Path | str,
    touched_files: list[str],
    profile: StackProfile | None = None,
) -> str | None:
    """Build the markdown section telling the agent which tests to generate.

    Returns None when there is nothing to test (no code files touched).
    """
    if not touched_files:
        return None
    if profile is None:
        profile = detect_stack(project_dir)

    groups: dict[str, list[str]] = {}
    for file_path in touched_files:
        kind = classify_file(file_path, profile)
        if kind:
            groups.setdefault(kind, []).append(file_path)
    if not groups:
        return None

    sections = [
        "## Automated Tests Required (stack-aware)",
        "",
        "Based on the files this subtask touches and the libraries installed in "
        "the project, you MUST also produce the following automated tests "
        "(in the same commit as the implementation):",
        "",
    ]
    for kind in (KIND_API, KIND_WINFORMS, KIND_WEB, KIND_UNIT):
        if kind in groups:
            sections.extend(_BUILDERS[kind](profile, groups[kind]))
            sections.append("")
    sections.append(
        "Only use test libraries that are already installed in the project — "
        "NEVER add new test dependencies. Run the relevant test suite and make "
        "sure it passes before marking the subtask complete."
    )
    return "\n".join(sections)
