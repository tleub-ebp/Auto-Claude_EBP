"""Go overlay."""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="go",
    test_commands=[
        "go test ./... -count=1          # -count=1 defeats the test cache",
        "go test -run '^TestName$' ./pkg",
        "go test -race ./...             # slower, catches data races",
    ],
    lint_commands=["go vet ./...", "gofmt -l ."],
    notes=(
        "Without -count=1 a passing cached result hides a regression. "
        "`go vet` catches a class of bugs the compiler does not."
    ),
)
