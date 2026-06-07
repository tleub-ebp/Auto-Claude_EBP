#!/usr/bin/env python3
"""
Security Auto-Integration
=========================

Automatic security integration for WorkPilot AI.
This module is ALWAYS LOADED and provides automatic security scanning.

Feature 8: Security-First Features is INCLUDED and NON-OPTIONAL.

This module:
1. Automatically scans for secrets on every commit (via Git hooks)
2. Runs quick security checks during development
3. Provides security warnings in the CLI
4. Integrates with the QA agent for security validation

The security features are built-in and cannot be disabled for safety.
However, specific scanners can be configured based on project needs.
"""

from __future__ import annotations

import os
import threading
import warnings
from pathlib import Path
from typing import Any

# Check for optional security tools
SECURITY_TOOLS_AVAILABLE = {
    "bandit": False,
    "semgrep": False,
    "pip-audit": False,
    "snyk": False,
}


_TOOL_AVAILABILITY_CHECKED = False
_tool_check_lock = threading.Lock()


def _check_tool_availability(force: bool = False):
    """Check which optional security tools are available.

    Lazy: only runs the first time it's actually needed (e.g., from
    `check_security_setup()`), so importing this module does not spawn 4
    subprocesses synchronously. Spawning at import time both blocked startup
    by up to ~1s on Windows and could execute attacker-controlled binaries
    named bandit/snyk/etc. that happened to be on PATH.
    """
    global _TOOL_AVAILABILITY_CHECKED
    # Fast path: already done and no force-recheck requested
    if _TOOL_AVAILABILITY_CHECKED and not force:
        return

    with _tool_check_lock:
        # Re-check under the lock to avoid double-work
        if _TOOL_AVAILABILITY_CHECKED and not force:
            return
        _TOOL_AVAILABILITY_CHECKED = True

    # Subprocess I/O happens OUTSIDE the lock to avoid blocking other threads
    import shutil
    import subprocess

    for tool in SECURITY_TOOLS_AVAILABLE.keys():
        # shutil.which() avoids spawning the binary at all when it is not on
        # PATH. We only invoke `--version` once we know the binary exists.
        if shutil.which(tool) is None:
            continue
        try:
            subprocess.run(
                [tool, "--version"],
                capture_output=True,
                timeout=2,
                check=False,
            )
            SECURITY_TOOLS_AVAILABLE[tool] = True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass


def get_default_security_config() -> dict[str, Any]:
    """
    Get default security configuration.

    This configuration is ALWAYS active for security.
    Users can customize behavior but cannot disable core features.

    Returns:
        Default security configuration
    """
    # Trigger lazy detection so SECURITY_TOOLS_AVAILABLE reflects the
    # actual install state. Without this, the dict stays at all-False
    # forever (the eager detection at import time was removed for safety
    # — see `_check_tool_availability` docstring).
    _check_tool_availability()
    return {
        "enabled": True,  # ALWAYS True - cannot be disabled
        "scan_on_commit": True,  # Automatic pre-commit secret scanning
        "scan_on_push": True,  # Full scan before push
        "scan_secrets": True,  # Built-in secret detection (always enabled)
        "scan_sast": SECURITY_TOOLS_AVAILABLE["bandit"],  # If Bandit available
        "scan_dependencies": SECURITY_TOOLS_AVAILABLE[
            "pip-audit"
        ],  # If pip-audit available
        "block_on_secrets": True,  # Always block on secrets
        "block_on_critical": True,  # Always block on critical vulnerabilities
        "compliance_frameworks": ["GDPR", "SOC2"],  # Default compliance checks
        "report_formats": ["json", "markdown"],  # Always generate reports
        "output_dir": ".security-reports",
    }


def is_security_enabled() -> bool:
    """
    Check if security features are enabled.

    Returns:
        Always True - security is non-optional
    """
    return True  # Security is always enabled - this is a core feature


def check_security_setup() -> dict[str, Any]:
    """
    Check security setup and provide recommendations.

    Returns:
        Dictionary with setup status and recommendations
    """
    # Trigger lazy detection — see `get_default_security_config` for why.
    _check_tool_availability()
    setup = {
        "core_features": "✅ Active (built-in)",
        "credential_leak_scanner_status": "✅ Active (built-in)",
        "recommendations": [],
        "warnings": [],
    }

    # Check optional tools
    if not SECURITY_TOOLS_AVAILABLE["bandit"]:
        setup["warnings"].append("⚠️ Bandit not installed - Python SAST disabled")
        setup["recommendations"].append(
            "Install Bandit for Python security analysis: pip install bandit"
        )

    if not SECURITY_TOOLS_AVAILABLE["semgrep"]:
        setup["recommendations"].append(
            "Install Semgrep for advanced SAST: pip install semgrep"
        )

    if not SECURITY_TOOLS_AVAILABLE["pip-audit"]:
        setup["recommendations"].append(
            "Install pip-audit for dependency scanning: pip install pip-audit"
        )

    if not SECURITY_TOOLS_AVAILABLE["snyk"]:
        setup["recommendations"].append(
            "Install Snyk for comprehensive scanning: npm install -g snyk"
        )

    # Check Git hooks
    git_dir = Path.cwd() / ".git"
    if git_dir.exists():
        hooks_dir = git_dir / "hooks"
        has_pre_commit = (hooks_dir / "pre-commit").exists()
        has_pre_push = (hooks_dir / "pre-push").exists()

        if not has_pre_commit or not has_pre_push:
            setup["warnings"].append(
                "⚠️ Git hooks not installed - automatic scanning disabled"
            )
            setup["recommendations"].append(
                "Install Git hooks: python -m security.git_hooks install"
            )
        else:
            setup["git_hooks"] = "✅ Installed"

    return setup


def print_security_status():
    """Print security status and recommendations."""
    print()
    print("🔒 Security-First Features (Feature 8) - Status")
    print("=" * 60)

    setup = check_security_setup()

    print(f"Core Features: {setup['core_features']}")
    print(f"Credential leak scanning: {setup['credential_leak_scanner_status']}")

    if "git_hooks" in setup:
        print(f"Git Hooks: {setup['git_hooks']}")

    if setup["warnings"]:
        print()
        print("Warnings:")
        for warning in setup["warnings"]:
            print(f"  {warning}")

    if setup["recommendations"]:
        print()
        print("Recommendations:")
        for rec in setup["recommendations"]:
            print(f"  • {rec}")

    print("=" * 60)
    print()


def auto_install_git_hooks() -> bool:
    """
    Automatically install Git hooks if in a Git repository.

    Returns:
        True if hooks were installed or already exist
    """
    git_dir = Path.cwd() / ".git"
    if not git_dir.exists():
        return False

    hooks_dir = git_dir / "hooks"
    pre_commit_hook = hooks_dir / "pre-commit"

    # Check if our hooks are already installed
    if pre_commit_hook.exists():
        content = pre_commit_hook.read_text()
        if "WorkPilot AI Security Scanner" in content:
            return True  # Already installed

    # Auto-install hooks
    try:
        from .git_hooks import GitHookManager

        manager = GitHookManager(Path.cwd())
        return manager.install_hooks()
    except Exception as e:
        warnings.warn(f"Failed to auto-install Git hooks: {e}", stacklevel=2)
        return False


def ensure_security_reports_dir() -> Path:
    """
    Ensure the security reports directory exists.

    Returns:
        Path to security reports directory
    """
    reports_dir = Path.cwd() / ".security-reports"
    reports_dir.mkdir(exist_ok=True)

    # Create .gitignore to avoid committing reports
    gitignore = reports_dir / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("# Auto-generated security reports\n*\n!.gitignore\n")

    return reports_dir


def run_quick_security_check() -> bool:
    """
    Run a quick security check (secrets only).

    This is called automatically in development mode.

    Returns:
        True if no issues found, False if issues detected
    """
    try:
        from .security_orchestrator import SecurityOrchestrator, SecurityScanConfig

        config = SecurityScanConfig()
        config.scan_secrets = True
        config.scan_sast = False
        config.scan_dependencies = False
        config.generate_json = False
        config.generate_markdown = False
        config.generate_html = False

        orchestrator = SecurityOrchestrator(Path.cwd(), config)
        result = orchestrator.run_quick_scan()

        return not result.should_block
    except Exception as e:
        warnings.warn(f"Quick security check failed: {e}", stacklevel=2)
        return True  # Don't block on errors


# =============================================================================
# Automatic Initialization
# =============================================================================

# This code runs when the module is imported
# It ensures security features are always available


def initialize_security() -> None:
    """Initialize security features.

    Must be called explicitly by application entry points — NOT at import
    time. Importing this module from anywhere previously created a
    `.security-reports/` directory in whatever cwd happened to be set,
    polluting random user directories whenever the package was loaded as a
    subprocess or from a CLI plugin context.

    Renamed from `_initialize_security` so external callers (e.g., the
    backend startup hook) can wire it up — the leading underscore caused
    every caller to skip it and the security init never ran in practice.
    """
    # Ensure reports directory exists
    ensure_security_reports_dir()

    # Check if we should print status (only in interactive mode)
    if os.getenv("AUTO_CLAUDE_INTERACTIVE") == "1":
        print_security_status()

    # Auto-install Git hooks in development
    if os.getenv("AUTO_CLAUDE_DEV_MODE") == "1":
        auto_install_git_hooks()


# Backwards-compat alias for any caller that still references the old name.
_initialize_security = initialize_security


# =============================================================================
# Public API
# =============================================================================

__all__ = [
    "is_security_enabled",
    "get_default_security_config",
    "check_security_setup",
    "initialize_security",
    "print_security_status",
    "auto_install_git_hooks",
    "run_quick_security_check",
    "SECURITY_TOOLS_AVAILABLE",
]
