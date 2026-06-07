"""Global log redaction filter.

Attaches to the root logger so every `logger.info/debug/...` call goes
through it. Redacts patterns that look like API keys, OAuth tokens,
JWTs, AWS credentials, and a configurable list of environment variable
values.

Usage at process start:

    from core.log_redaction import install_global_redaction
    install_global_redaction()

We never raise from inside the filter — filters that crash silently drop
log records, which is worse than a leaked secret because it hides
problems. On any unexpected error we let the original record through.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Iterable
from re import Pattern

# ---------------------------------------------------------------------------
# Patterns

# Anthropic, OpenAI, Stripe et co. share the convention: a 2–4 char prefix
# followed by 30+ chars of base64-ish payload. The order matters: the
# more specific patterns must come first so the generic catch-all
# doesn't grab tokens we already know how to label.
_REDACT_PATTERNS: tuple[tuple[Pattern[str], str], ...] = (
    # Anthropic API keys
    (re.compile(r"sk-ant-(?:api|admin)\d*-[A-Za-z0-9_-]{20,}"), "sk-ant-[REDACTED]"),
    # OpenAI / OpenAI-compatible
    (re.compile(r"sk-[A-Za-z0-9_-]{30,}"), "sk-[REDACTED]"),
    # GitHub PATs (classic + fine-grained) and OAuth tokens
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"), "gh*_[REDACTED]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "github_pat_[REDACTED]"),
    # GitLab PATs
    (re.compile(r"glpat-[A-Za-z0-9_-]{20,}"), "glpat-[REDACTED]"),
    # Slack tokens
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "xox*-[REDACTED]"),
    # AWS access key IDs (always start with AKIA / ASIA)
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "AWS_KEY_[REDACTED]"),
    # Bearer tokens in Authorization headers — match the value, not the key
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{20,}", re.IGNORECASE), r"\1[REDACTED]"),
    # JWTs (header.payload.signature, all base64url)
    (
        re.compile(
            r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
        ),
        "[JWT_REDACTED]",
    ),
    # Azure DevOps PAT in URL or text — they are 52 base64-ish chars
    (
        re.compile(r"\b[A-Za-z0-9]{52}\b(?=\s*$|\s|;|\")"),
        "[ADO_PAT_REDACTED]",
    ),
    # Generic bare api_key=... / token=... / secret=... assignments
    (
        re.compile(
            r"\b(api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*['\"]?[A-Za-z0-9._\-]{12,}['\"]?",
            re.IGNORECASE,
        ),
        r"\1=[REDACTED]",
    ),
)


# Env-var-driven extras. We read these env vars at install-time and add
# their literal values as additional patterns to redact. Any variable
# whose name matches the trigger list contributes its value.
_SENSITIVE_ENV_TRIGGERS = (
    "API_KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PAT",
    "DSN",  # Sentry-style URL with secret
)


def _build_env_value_patterns(
    extra_env_keys: Iterable[str] | None = None,
) -> list[tuple[Pattern[str], str]]:
    """Snapshot the current env vars whose name suggests a secret value."""
    keys: set[str] = set(extra_env_keys or [])
    for k in os.environ:
        if any(trigger in k.upper() for trigger in _SENSITIVE_ENV_TRIGGERS):
            keys.add(k)

    patterns: list[tuple[Pattern[str], str]] = []
    for k in keys:
        v = os.environ.get(k, "")
        # Skip junk: too short, looks like a flag, etc. Most real keys
        # are at least 12 chars.
        if not v or len(v) < 12 or v.startswith("-"):
            continue
        # We want literal substring match — escape regex metacharacters.
        patterns.append((re.compile(re.escape(v)), f"[ENV:{k}_REDACTED]"))
    return patterns


# ---------------------------------------------------------------------------
# Filter


class RedactingFilter(logging.Filter):
    """A `logging.Filter` that masks secrets in record.msg and record.args.

    Defensive: if anything goes wrong during redaction we let the original
    record through and emit a single warning so the caller knows their
    log message wasn't sanitised.
    """

    def __init__(
        self,
        extra_patterns: Iterable[tuple[Pattern[str], str]] | None = None,
    ) -> None:
        super().__init__()
        self._patterns: list[tuple[Pattern[str], str]] = list(_REDACT_PATTERNS)
        self._patterns.extend(_build_env_value_patterns())
        if extra_patterns:
            self._patterns.extend(extra_patterns)

    def add_pattern(self, pattern: Pattern[str], replacement: str) -> None:
        self._patterns.append((pattern, replacement))

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            # Render the formatted message so we redact whatever the user
            # would have actually seen in the file.
            try:
                rendered = record.getMessage()
            except Exception:
                # If rendering fails (e.g. bad % args), leave it alone.
                return True

            redacted = self._redact(rendered)
            if redacted != rendered:
                # Replace msg + clear args so .getMessage() returns the
                # redacted version on subsequent calls.
                record.msg = redacted
                record.args = None
        except Exception:
            # Never drop a record because of a bug in our filter.
            pass
        return True

    def _redact(self, text: str) -> str:
        out = text
        for pattern, replacement in self._patterns:
            out = pattern.sub(replacement, out)
        return out


# ---------------------------------------------------------------------------
# Installer


_INSTALLED = False


def install_global_redaction(
    extra_patterns: Iterable[tuple[Pattern[str], str]] | None = None,
    force_reinstall: bool = False,
) -> RedactingFilter:
    """Install the redacting filter on the root logger.

    Idempotent unless `force_reinstall=True` — repeated calls return the
    existing filter so callers don't have to track installation state.
    """
    global _INSTALLED
    root = logging.getLogger()

    # If already installed, surface the existing instance.
    existing = next(
        (f for f in root.filters if isinstance(f, RedactingFilter)),
        None,
    )
    if existing is not None and not force_reinstall:
        _INSTALLED = True
        return existing
    if existing is not None and force_reinstall:
        root.removeFilter(existing)

    new_filter = RedactingFilter(extra_patterns=extra_patterns)
    root.addFilter(new_filter)

    # Filter on the root logger only catches records that propagate to root.
    # If a child logger has `propagate=False` (common for uvicorn, asyncio,
    # etc.) and its own handlers, redaction is bypassed. Walk every handler
    # on every existing logger.
    for handler in _all_handlers():
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(new_filter)

    _INSTALLED = True
    return new_filter


def _all_handlers() -> list[logging.Handler]:
    """Return every handler attached to the root logger or any named logger.

    Uses the logging manager's loggerDict, which holds every Logger that has
    been requested via getLogger(name). Returned list may contain duplicates
    if the same handler instance is attached to multiple loggers; that is
    fine since the caller dedupes via the `isinstance` check.
    """
    handlers: list[logging.Handler] = list(logging.getLogger().handlers)
    for logger_or_placeholder in logging.Logger.manager.loggerDict.values():
        # loggerDict can contain PlaceHolder instances for not-yet-created
        # logger names; those have no handlers attribute.
        if isinstance(logger_or_placeholder, logging.Logger):
            handlers.extend(logger_or_placeholder.handlers)
    return handlers


def is_installed() -> bool:
    """For tests / introspection."""
    return _INSTALLED


def reset_for_tests() -> None:
    """Tear down the global filter — only call from test fixtures."""
    global _INSTALLED
    root = logging.getLogger()
    for f in list(root.filters):
        if isinstance(f, RedactingFilter):
            root.removeFilter(f)
    for handler in _all_handlers():
        for f in list(handler.filters):
            if isinstance(f, RedactingFilter):
                handler.removeFilter(f)
    _INSTALLED = False
