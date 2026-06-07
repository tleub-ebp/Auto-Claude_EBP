"""Tests for the coder self-review handoff helper."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest
from agents.self_review import (
    SELF_REVIEW_ENV_VAR,
    SELF_REVIEW_FILENAME,
    DiffSummary,
    build_self_review_prompt,
    compute_diff_summary,
    run_self_review,
    self_review_enabled,
    write_self_review_stub,
)

# ---------------------------------------------------------------------------
# self_review_enabled


class TestSelfReviewEnabled:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("1", True),
            ("true", True),
            ("YES", True),
            ("on", True),
            ("0", False),
            ("false", False),
            ("", False),
            ("nonsense", False),
        ],
    )
    def test_truthy_parsing(
        self, monkeypatch: pytest.MonkeyPatch, value: str, expected: bool
    ) -> None:
        monkeypatch.setenv(SELF_REVIEW_ENV_VAR, value)
        assert self_review_enabled() is expected

    def test_default_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(SELF_REVIEW_ENV_VAR, raising=False)
        assert self_review_enabled() is False


# ---------------------------------------------------------------------------
# Diff summary helpers


def _git_init_with_change(repo: Path) -> None:
    """Create a minimal repo with one commit + an unstaged modification."""
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"], cwd=repo, check=True
    )
    subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True)
    (repo / "src.py").write_text("def foo():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    # Modify the file so we have a diff vs HEAD.
    (repo / "src.py").write_text(
        "def foo():\n    return 2\n\ndef bar():\n    return 'x'\n",
        encoding="utf-8",
    )


class TestComputeDiffSummary:
    def test_missing_dir_returns_error(self, tmp_path: Path) -> None:
        result = compute_diff_summary(tmp_path / "spec", tmp_path / "ghost")
        assert result.files_changed == []
        assert result.error and "not a directory" in result.error

    def test_non_git_dir_returns_error(self, tmp_path: Path) -> None:
        result = compute_diff_summary(tmp_path / "spec", tmp_path)
        assert result.error and "not a git repo" in result.error

    @pytest.mark.skipif(
        subprocess.run(["git", "--version"], capture_output=True).returncode != 0,
        reason="git not available",
    )
    def test_collects_files_and_stats_from_real_repo(self, tmp_path: Path) -> None:
        _git_init_with_change(tmp_path)
        result = compute_diff_summary(tmp_path / "spec", tmp_path)
        assert result.error is None
        assert "src.py" in result.files_changed
        assert result.insertions > 0
        assert result.diff_excerpt
        assert "def bar" in result.diff_excerpt

    def test_long_diff_is_truncated(self, tmp_path: Path) -> None:
        # Force a huge fake diff via monkeypatching the git wrapper.
        from agents import self_review as sr

        def fake_git(args, cwd):
            if args == ["rev-parse", "--is-inside-work-tree"]:
                return 0, "true\n", ""
            if args == ["diff", "HEAD", "--name-only"]:
                return 0, "x.py\n", ""
            if args == ["diff", "HEAD", "--numstat"]:
                return 0, "1\t0\tx.py\n", ""
            if args == ["diff", "HEAD"]:
                return 0, "x" * 100_000, ""
            return 1, "", "unexpected"

        # The function patched is module-level; replace it for this test only.
        original = sr._git
        sr._git = fake_git
        try:
            result = compute_diff_summary(tmp_path, tmp_path)
            assert result.truncated is True
            assert "[truncated by self_review excerpt cap]" in result.diff_excerpt
            assert len(result.diff_excerpt) < 100_000
        finally:
            sr._git = original


# ---------------------------------------------------------------------------
# Prompt builder


class TestPromptBuilder:
    def test_includes_spec_id_and_three_sections(self) -> None:
        summary = DiffSummary(
            files_changed=["a.py", "b.py"],
            insertions=10,
            deletions=2,
            diff_excerpt="diff content",
        )
        prompt = build_self_review_prompt("spec-42", summary)
        assert "spec-42" in prompt
        assert "What I changed" in prompt
        assert "What might break" in prompt
        assert "What I didn't test" in prompt
        # Stats land in the prompt.
        assert "+10" in prompt
        assert "-2" in prompt

    def test_caps_files_listing_at_50(self) -> None:
        summary = DiffSummary(
            files_changed=[f"f{i}.py" for i in range(60)],
            insertions=0,
            deletions=0,
        )
        prompt = build_self_review_prompt("s", summary)
        assert "and 10 more" in prompt


# ---------------------------------------------------------------------------
# Stub writer


class TestWriteStub:
    def test_writes_self_review_md(self, tmp_path: Path) -> None:
        summary = DiffSummary(
            files_changed=["a.py"],
            insertions=5,
            deletions=1,
        )
        path = write_self_review_stub(tmp_path, summary)
        assert path == tmp_path / SELF_REVIEW_FILENAME
        content = path.read_text(encoding="utf-8")
        assert "## What I changed" in content
        assert "## What might break" in content
        assert "## What I didn't test" in content
        assert "+5 / -1" in content

    def test_includes_error_note_when_present(self, tmp_path: Path) -> None:
        summary = DiffSummary(error="git timed out")
        path = write_self_review_stub(tmp_path, summary)
        assert "git timed out" in path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# run_self_review (async)


class _MockClient:
    def __init__(self, response: str) -> None:
        self.response = response
        self.invoked_with: str | None = None

    async def invoke(self, prompt: str) -> str:
        self.invoked_with = prompt
        return self.response


class _RaisingClient:
    async def invoke(self, prompt: str) -> str:
        raise RuntimeError("simulated SDK failure")


class TestRunSelfReview:
    def test_no_client_writes_stub(self, tmp_path: Path) -> None:
        path = asyncio.run(run_self_review(None, tmp_path, tmp_path))
        assert path is not None
        assert path.exists()
        assert "auto-generated stub" in path.read_text(encoding="utf-8")

    def test_well_formed_response_is_written_verbatim(self, tmp_path: Path) -> None:
        good = (
            "# Coder self-review\n\n"
            "## What I changed\n- thing\n\n"
            "## What might break\n- other\n\n"
            "## What I didn't test\n- nothing\n"
        )
        client = _MockClient(good)
        path = asyncio.run(run_self_review(client, tmp_path, tmp_path))
        assert path is not None
        content = path.read_text(encoding="utf-8")
        assert content == good
        # Client was actually called with a prompt that mentioned the spec id.
        assert client.invoked_with and tmp_path.name in client.invoked_with

    def test_malformed_response_is_wrapped(self, tmp_path: Path) -> None:
        client = _MockClient("just some prose without sections")
        path = asyncio.run(run_self_review(client, tmp_path, tmp_path))
        assert path is not None
        content = path.read_text(encoding="utf-8")
        assert "## What I changed" in content
        assert "just some prose without sections" in content
        # The fallback markers for the missing sections must appear.
        assert "didn't follow the requested" in content

    def test_sdk_failure_falls_back_to_stub(self, tmp_path: Path) -> None:
        path = asyncio.run(run_self_review(_RaisingClient(), tmp_path, tmp_path))
        assert path is not None
        assert "auto-generated stub" in path.read_text(encoding="utf-8")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
