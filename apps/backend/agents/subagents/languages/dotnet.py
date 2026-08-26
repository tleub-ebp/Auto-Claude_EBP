""".NET overlay."""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="dotnet",
    test_commands=[
        "dotnet test --nologo",
        'dotnet test --filter "FullyQualifiedName~<Name>"',
        "dotnet test --logger 'console;verbosity=detailed'",
    ],
    lint_commands=[
        "dotnet format --verify-no-changes",
        "dotnet build -warnaserror",
    ],
    notes=(
        "Build before testing: `dotnet test` reports a compile error as a run "
        "failure, which reads like a broken test. Check the TargetFramework in "
        "the .csproj — guidance for .NET 10 does not apply to .NET Framework 4.8."
    ),
)
