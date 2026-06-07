"""Tests pour le garde-fou ``QA_FIX_REQUEST.md`` de la boucle QA."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def ensure_helper():
    """Importe ``_ensure_fix_request_file`` après le hook conftest qa_loop."""
    from qa.loop import _ensure_fix_request_file

    return _ensure_fix_request_file


def test_keeps_existing_file_untouched(tmp_path: Path, ensure_helper) -> None:
    fix_request = tmp_path / "QA_FIX_REQUEST.md"
    fix_request.write_text("contenu existant", encoding="utf-8")

    created = ensure_helper(tmp_path, [{"title": "x"}], qa_iteration=1)

    assert created is True
    assert fix_request.read_text(encoding="utf-8") == "contenu existant"


def test_synthesizes_from_issues_when_missing(tmp_path: Path, ensure_helper) -> None:
    issues = [
        {
            "title": "Fichiers locales manquants",
            "description": "es.resx, fr-BE.resx, nl-BE.resx absents",
            "severity": "critical",
        },
        {"title": "Vérification runtime impossible", "severity": "info"},
    ]

    created = ensure_helper(tmp_path, issues, qa_iteration=2)

    fix_request = tmp_path / "QA_FIX_REQUEST.md"
    assert created is True
    content = fix_request.read_text(encoding="utf-8")
    assert "Fichiers locales manquants" in content
    assert "es.resx, fr-BE.resx, nl-BE.resx absents" in content
    assert "critical" in content
    assert "Vérification runtime impossible" in content


def test_returns_false_when_no_issues_and_no_file(
    tmp_path: Path, ensure_helper
) -> None:
    created = ensure_helper(tmp_path, [], qa_iteration=1)

    assert created is False
    assert not (tmp_path / "QA_FIX_REQUEST.md").exists()
