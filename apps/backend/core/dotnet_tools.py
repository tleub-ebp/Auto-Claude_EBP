"""
.NET Build Tool Discovery
=========================

Locates MSBuild.exe and dotnet.exe on the current machine, supporting both
Visual Studio and JetBrains Rider installations on Windows.

On non-Windows platforms, falls back to `dotnet build` as the canonical command.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from core.platform import is_windows as _is_windows
except ImportError:

    def _is_windows() -> bool:  # type: ignore[misc]
        return sys.platform == "win32"


@dataclass
class DotnetBuildInfo:
    """Information about available .NET build tools."""

    dotnet_exe: str | None
    """Full path (or plain name if on PATH) for `dotnet` CLI."""

    msbuild_exe: str | None
    """Full path to MSBuild.exe, or None if not found."""

    preferred_build_cmd: str
    """Ready-to-use command for `dotnet build <project>` style builds."""

    preferred_msbuild_cmd: str
    """Ready-to-use command for MSBuild-style builds (build target)."""

    is_windows: bool

    notes: list[str]
    """Human-readable notes about what was found / fallbacks used."""


def _run_silent(cmd: list[str], timeout: int = 5) -> str | None:
    """Run a command and return stdout, or None on error."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _find_msbuild_via_vswhere() -> str | None:
    """Locate MSBuild.exe using vswhere.exe (ships with VS 2017+)."""
    vswhere_paths = [
        r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe",
        r"C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe",
    ]
    for vswhere in vswhere_paths:
        if not Path(vswhere).exists():
            continue
        output = _run_silent(
            [
                vswhere,
                "-latest",
                "-requires",
                "Microsoft.Component.MSBuild",
                "-find",
                r"MSBuild\**\Bin\MSBuild.exe",
            ]
        )
        if output:
            # vswhere may return multiple lines; take the last (highest version)
            candidates = [line.strip() for line in output.splitlines() if line.strip()]
            if candidates:
                return candidates[-1]
    return None


def _find_msbuild_at_known_paths() -> str | None:
    """Probe known MSBuild locations for VS 2019/2022 (Community/Pro/Enterprise)."""
    editions = ["Enterprise", "Professional", "Community", "BuildTools"]
    vs_versions = ["2022", "2019", "2017"]
    base_dirs = [
        r"C:\Program Files\Microsoft Visual Studio",
        r"C:\Program Files (x86)\Microsoft Visual Studio",
    ]
    # MSBuild version sub-paths (newest to oldest within each VS)
    msbuild_subdirs = [
        r"MSBuild\Current\Bin\MSBuild.exe",
        r"MSBuild\17.0\Bin\MSBuild.exe",
        r"MSBuild\16.0\Bin\MSBuild.exe",
        r"MSBuild\15.0\Bin\MSBuild.exe",
    ]
    for base in base_dirs:
        for ver in vs_versions:
            for edition in editions:
                for sub in msbuild_subdirs:
                    candidate = Path(base) / ver / edition / sub
                    if candidate.exists():
                        return str(candidate)
    return None


def _find_dotnet() -> str | None:
    """Return dotnet executable path: prefer PATH, then known locations."""
    if shutil.which("dotnet"):
        return "dotnet"
    if sys.platform == "win32":
        candidates = [
            r"C:\Program Files\dotnet\dotnet.exe",
            r"C:\Program Files (x86)\dotnet\dotnet.exe",
        ]
        for c in candidates:
            if Path(c).exists():
                return c
    return None


def detect_dotnet_project(project_dir: Path) -> bool:
    """Return True if the project contains at least one .csproj, .vbproj, .fsproj or .sln."""
    for pattern in ("**/*.csproj", "**/*.vbproj", "**/*.fsproj", "*.sln"):
        if any(project_dir.glob(pattern)):
            return True
    return False


def is_legacy_framework_project(project_dir: Path) -> bool:
    """
    Return True if the project appears to use old-style .NET Framework csproj format.

    SDK-style projects have `<Project Sdk="Microsoft.NET.SDK">` on the first line.
    Legacy .NET Framework projects use the verbose pre-SDK format without the Sdk attribute.
    """
    for pattern in ("**/*.csproj", "**/*.vbproj", "**/*.fsproj"):
        for csproj in project_dir.glob(pattern):
            try:
                content = csproj.read_text(encoding="utf-8", errors="replace")
                # SDK-style projects always contain 'Sdk=' near the top
                first_2k = content[:2048].lower()
                if "sdk=" not in first_2k and "<project" in first_2k:
                    return True
            except OSError:
                pass
    return False


def get_build_info(project_dir: Path | None = None) -> DotnetBuildInfo:
    """
    Detect available .NET build tools for the current machine.

    Args:
        project_dir: Optional project root, used to confirm this is a .NET project.

    Returns:
        DotnetBuildInfo with resolved paths and ready-to-use commands.
    """
    is_windows = _is_windows()
    notes: list[str] = []

    dotnet_exe = _find_dotnet()
    msbuild_exe: str | None = None

    if is_windows:
        # Try vswhere first (most reliable)
        msbuild_exe = _find_msbuild_via_vswhere()
        if msbuild_exe:
            notes.append(f"MSBuild found via vswhere: {msbuild_exe}")
        else:
            # Probe known paths
            msbuild_exe = _find_msbuild_at_known_paths()
            if msbuild_exe:
                notes.append(f"MSBuild found at known path: {msbuild_exe}")
            else:
                notes.append(
                    "MSBuild.exe not found via vswhere or known paths. "
                    "Ensure Visual Studio or Build Tools is installed."
                )

    if dotnet_exe:
        notes.append(f"dotnet CLI found: {dotnet_exe}")
    else:
        notes.append(
            "dotnet CLI not found on PATH. Install .NET SDK from https://dot.net"
        )

    # Compose ready-to-use template commands (caller substitutes <project>)
    if dotnet_exe:
        cmd = f'"{dotnet_exe}"' if " " in dotnet_exe else dotnet_exe
        preferred_build_cmd = f"{cmd} build <project> -c Debug"
    else:
        preferred_build_cmd = "dotnet build <project> -c Debug"

    if msbuild_exe and is_windows:
        q = f'"{msbuild_exe}"'
        preferred_msbuild_cmd = f"{q} <project> /p:Configuration=Debug /t:Build"
    elif dotnet_exe:
        cmd = f'"{dotnet_exe}"' if " " in dotnet_exe else dotnet_exe
        preferred_msbuild_cmd = f"{cmd} build <project> -c Debug"
    else:
        preferred_msbuild_cmd = "dotnet build <project> -c Debug"

    return DotnetBuildInfo(
        dotnet_exe=dotnet_exe,
        msbuild_exe=msbuild_exe,
        preferred_build_cmd=preferred_build_cmd,
        preferred_msbuild_cmd=preferred_msbuild_cmd,
        is_windows=is_windows,
        notes=notes,
    )


def generate_dotnet_env_section(project_dir: Path) -> str:
    """
    Generate a markdown section for the agent prompt explaining how to build
    .NET projects on this machine.

    Returns empty string if no .NET project files are detected.
    """
    if not detect_dotnet_project(project_dir):
        return ""

    info = get_build_info(project_dir)
    is_legacy = is_legacy_framework_project(project_dir)

    lines = ["## .NET Build Tools\n"]

    if info.is_windows:
        lines.append(
            "**Shell**: This is a **Windows** environment. "
            "Commands run in `cmd.exe` — do NOT use Unix-only commands "
            "(`tail`, `grep`, `cat`, `ls`) or PowerShell cmdlets "
            "(`Select-String`, `Get-ChildItem`). "
            "Use `type <file>`, `findstr`, `dir`, `find` instead. "
            "NEVER append `| tail -5` or similar Unix pipes.\n"
        )
    else:
        lines.append(
            "**Shell**: This is a Unix/macOS environment — use standard shell commands.\n"
        )

    if is_legacy:
        lines.append(
            "**Project type**: This project uses **legacy .NET Framework** format (non-SDK style csproj). "
            "`dotnet build` may NOT work for these projects. "
            "Use **MSBuild.exe** (see below) as the primary build tool.\n"
        )
    else:
        lines.append(
            "**Project type**: SDK-style .NET project. "
            "Use `dotnet build` (preferred) or MSBuild.\n"
        )

    lines.append("---\n")
    lines.append("**Build workflow (always in this order):**\n")

    if info.is_windows and info.msbuild_exe and is_legacy:
        q = f'"{info.msbuild_exe}"'
        lines.append(
            "### Step 1 — Restore NuGet packages\n"
            f"```cmd\n{q} <path\\to\\solution.sln> /t:Restore\n```\n"
            "Or if no solution file, use NuGet CLI:\n"
            "```cmd\nnuget restore <path\\to\\solution.sln>\n```\n"
        )
        lines.append(
            "### Step 2 — Build the project/solution\n"
            f"```cmd\n{q} <path\\to\\project.csproj> /p:Configuration=Debug /t:Build\n```\n"
            f"For a full solution:\n"
            f"```cmd\n{q} <path\\to\\solution.sln> /p:Configuration=Debug /t:Build\n```\n"
            "**To validate only the project you modified (skip dependencies)**:\n"
            f"```cmd\ndotnet build <path\\to\\your-modified-project.csproj> --no-dependencies -c Debug\n```\n"
        )
        lines.append(
            f"**MSBuild path**: `{info.msbuild_exe}`\n"
            "NEVER use `msbuild` as a bare command — use the full path above.\n"
        )
    elif info.dotnet_exe:
        dotnet = f'"{info.dotnet_exe}"' if " " in info.dotnet_exe else info.dotnet_exe
        lines.append(
            "### Step 1 — Restore NuGet packages\n"
            f"```cmd\n{dotnet} restore <path\\to\\project.csproj>\n```\n"
        )
        lines.append(
            "### Step 2 — Build\n"
            f"```cmd\n{dotnet} build <path\\to\\project.csproj> --no-dependencies -c Debug\n```\n"
            "The `--no-dependencies` flag builds only the specific project without recompiling "
            "all dependency projects — essential for EBP projects where dependency projects "
            "may have pre-existing errors in the dotnet SDK context.\n"
        )
        if info.is_windows and info.msbuild_exe:
            q = f'"{info.msbuild_exe}"'
            lines.append(
                f"**Fallback — MSBuild** (if `dotnet build` fails):\n"
                f"```cmd\n{q} <path\\to\\project.csproj> /p:Configuration=Debug /t:Restore;Build\n```\n"
            )
    else:
        lines.append(
            "```cmd\n# dotnet CLI not found — install .NET SDK from https://dot.net\n```\n"
        )

    lines.append(
        "---\n"
        "**IMPORTANT — Pre-existing environment errors (DO NOT try to fix)**:\n"
        "This project uses EBP internal assemblies (`EBP.BusinessFramework`, `EBP.Framework`, etc.) "
        "that are NOT available as NuGet packages. They exist only in the Visual Studio / Rider environment. "
        "If the build reports errors like:\n"
        "  - `CS0234: 'BusinessFramework' does not exist in namespace 'EBP'`\n"
        "  - `CS0103: 'EbpProductVersion' does not exist`\n"
        "  - `MSB3823: resources require GenerateResourceUsePreserializedResources`\n"
        "  - `MSB3822: System.Resources.Extensions assembly not found`\n"
        "These are **pre-existing infrastructure errors** that only appear with `dotnet` SDK outside VS. "
        "They are NOT caused by your changes. Do NOT attempt to fix them.\n\n"
        "**Correct build validation workflow**:\n"
        "1. Run build on only the specific project you modified (not the full solution):\n"
        "   ```cmd\n"
        "   dotnet build <your-modified-project.csproj> --no-dependencies -c Debug\n"
        "   ```\n"
        "2. If it fails **only** with pre-existing EBP assembly errors → your change is acceptable, "
        "continue.\n"
        "3. If it fails with errors **in files you wrote/modified** → fix those errors.\n"
        "4. Never block your task because of errors in files you did NOT modify.\n"
    )

    return "\n".join(lines)
