"""Tests for the advisory virtual reviewer."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from virtual_reviewer import (
    VIRTUAL_REVIEW_FILENAME,
    VIRTUAL_REVIEWER_ENV_VAR,
    compute_review_summary,
    run_virtual_review,
    virtual_reviewer_enabled,
    write_virtual_review_stub,
)

# ---------------------------------------------------------------------------
# Env flag


class TestEnabled:
    def test_default_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(VIRTUAL_REVIEWER_ENV_VAR, raising=False)
        assert virtual_reviewer_enabled() is False

    @pytest.mark.parametrize("v", ["1", "true", "YES", "on"])
    def test_truthy_values(self, monkeypatch: pytest.MonkeyPatch, v: str) -> None:
        monkeypatch.setenv(VIRTUAL_REVIEWER_ENV_VAR, v)
        assert virtual_reviewer_enabled() is True

    @pytest.mark.parametrize("v", ["0", "false", "", "garbage"])
    def test_falsy_values(self, monkeypatch: pytest.MonkeyPatch, v: str) -> None:
        monkeypatch.setenv(VIRTUAL_REVIEWER_ENV_VAR, v)
        assert virtual_reviewer_enabled() is False


# ---------------------------------------------------------------------------
# Summary collection


class TestComputeReviewSummary:
    def test_collects_basic_signals(self, tmp_path: Path) -> None:
        spec = tmp_path / "spec-1"
        spec.mkdir()
        (spec / "spec.md").write_text("# spec\n", encoding="utf-8")
        (spec / "qa_report.md").write_text("ok\n", encoding="utf-8")
        (spec / "self_review.md").write_text("notes", encoding="utf-8")

        summary = compute_review_summary(spec, tmp_path)
        assert summary.spec_id == "spec-1"
        assert summary.spec_chars == len("# spec\n")
        assert summary.qa_report_chars == 3
        assert summary.self_review_present is True

    def test_self_review_absent_signalled(self, tmp_path: Path) -> None:
        spec = tmp_path / "spec-2"
        spec.mkdir()
        summary = compute_review_summary(spec, tmp_path)
        assert summary.self_review_present is False

    def test_does_not_raise_on_non_git_dir(self, tmp_path: Path) -> None:
        # No git repo in tmp_path — diff capture will fail. Summary still
        # returned, error populated.
        spec = tmp_path / "spec-3"
        spec.mkdir()
        summary = compute_review_summary(spec, tmp_path)
        # Either empty diff_excerpt or an error string — both are fine.
        assert summary.diff_excerpt == "" or summary.error is not None


# ---------------------------------------------------------------------------
# Stub writer


class TestStubWriter:
    def test_writes_with_banner(self, tmp_path: Path) -> None:
        from virtual_reviewer.reviewer import VirtualReviewSummary

        summary = VirtualReviewSummary(
            spec_id="spec-x",
            spec_chars=100,
            qa_report_chars=50,
            self_review_present=True,
        )
        path = write_virtual_review_stub(tmp_path, summary)
        assert path.name == VIRTUAL_REVIEW_FILENAME
        content = path.read_text(encoding="utf-8")
        # Banner is always present.
        assert "AUTO-GENERATED VIRTUAL REVIEW" in content
        assert "NOT A HUMAN APPROVAL" in content
        # Stats round-trip.
        assert "100 chars" in content
        assert "50 chars" in content


# ---------------------------------------------------------------------------
# run_virtual_review


class _MockClient:
    def __init__(self, response: str) -> None:
        self.response = response

    async def invoke(self, prompt: str) -> str:
        return self.response


class _RaisingClient:
    async def invoke(self, prompt: str) -> str:
        raise RuntimeError("simulated SDK failure")


class TestRunVirtualReview:
    def test_no_client_writes_stub(self, tmp_path: Path) -> None:
        path = asyncio.run(run_virtual_review(None, tmp_path, tmp_path))
        assert path is not None
        content = path.read_text(encoding="utf-8")
        assert "deterministic stub" in content

    def test_response_gets_banner_prepended(self, tmp_path: Path) -> None:
        client = _MockClient(
            "## Summary\nLooks good\n\n## Concerns\nnone\n## Approve?\n✅\n"
        )
        path = asyncio.run(run_virtual_review(client, tmp_path, tmp_path))
        assert path is not None
        content = path.read_text(encoding="utf-8")
        assert content.startswith("<!-- AUTO-GENERATED VIRTUAL REVIEW")
        assert "Looks good" in content

    def test_response_with_existing_banner_not_duplicated(self, tmp_path: Path) -> None:
        client = _MockClient(
            "<!-- AUTO-GENERATED VIRTUAL REVIEW — NOT A HUMAN APPROVAL -->\n\n"
            "> ⚠ **Machine-generated advisory review.**\n"
            "> This document was produced by the Virtual Reviewer agent. It is\n"
            "> *not* a human approval, *not* signed in anyone's name, and *not*\n"
            "> a substitute for a real review. Read it as a starting point.\n\n"
            "## Summary\nx\n"
        )
        path = asyncio.run(run_virtual_review(client, tmp_path, tmp_path))
        content = path.read_text(encoding="utf-8")
        # Banner appears exactly once.
        assert content.count("AUTO-GENERATED VIRTUAL REVIEW") == 1

    def test_sdk_failure_falls_back_to_stub(self, tmp_path: Path) -> None:
        path = asyncio.run(run_virtual_review(_RaisingClient(), tmp_path, tmp_path))
        assert path is not None
        assert "deterministic stub" in path.read_text(encoding="utf-8")

    def test_output_never_signed(self, tmp_path: Path) -> None:
        # Even if the model tries to sign, the banner's machine-generated
        # disclaimer is rendered BEFORE the model output, so a casual reader
        # never mistakes the file for a real human review.
        client = _MockClient(
            "## Summary\nReviewed by Bob Smith\n\n— Bob Smith, Senior Engineer"
        )
        path = asyncio.run(run_virtual_review(client, tmp_path, tmp_path))
        content = path.read_text(encoding="utf-8")
        banner_pos = content.find("Machine-generated advisory review")
        sig_pos = content.find("Bob Smith")
        assert banner_pos != -1, "banner missing from rendered output"
        assert sig_pos == -1 or banner_pos < sig_pos


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
