"""Rust overlay."""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="rust",
    test_commands=[
        "cargo test",
        "cargo test <name> -- --nocapture   # to see println! output",
    ],
    lint_commands=[
        "cargo clippy -- -D warnings",
        "cargo fmt --check",
    ],
    notes=(
        "cargo test swallows stdout unless --nocapture is passed. Clippy "
        "findings are usually more actionable than the compiler's."
    ),
)
