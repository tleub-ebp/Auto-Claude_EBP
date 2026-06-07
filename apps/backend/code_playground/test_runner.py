"""Tests for the Code Playground subprocess runner."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from code_playground import (
    PlaygroundLanguage,
    PlaygroundResult,
    PlaygroundRunner,
    PlaygroundTimeout,
    available_languages,
    run_snippet,
)
from code_playground.runner import (
    DEFAULT_OUTPUT_CAP_BYTES,
    TRUNCATION_MARKER,
    _cap_output,
)

# ---------------------------------------------------------------------------
# Language detection


class TestAvailableLanguages:
    def test_python_always_available(self) -> None:
        # We're literally executing inside Python — Python must be runnable.
        assert PlaygroundLanguage.PYTHON in available_languages()

    def test_returns_only_enum_members(self) -> None:
        for lang in available_languages():
            assert isinstance(lang, PlaygroundLanguage)


# ---------------------------------------------------------------------------
# Happy-path execution


class TestPythonExecution:
    def test_simple_print_captured(self) -> None:
        result = run_snippet("print('hello playground')")
        assert result.succeeded
        assert result.exit_code == 0
        assert "hello playground" in result.stdout
        assert result.stderr == ""
        assert result.language is PlaygroundLanguage.PYTHON
        assert result.duration_seconds >= 0
        assert result.truncated is False

    def test_nonzero_exit_code_does_not_raise(self) -> None:
        result = run_snippet("import sys\nsys.exit(7)")
        assert result.succeeded is False
        assert result.exit_code == 7

    def test_stderr_captured_separately(self) -> None:
        result = run_snippet("import sys\nsys.stderr.write('boom\\n')\nsys.exit(2)")
        assert "boom" in result.stderr
        assert result.exit_code == 2
        assert result.stdout == ""

    def test_uncaught_exception_does_not_crash_runner(self) -> None:
        result = run_snippet("raise ValueError('nope')")
        assert result.exit_code != 0
        assert "ValueError" in result.stderr
        assert "nope" in result.stderr

    def test_stdin_is_forwarded(self) -> None:
        result = run_snippet(
            "import sys\nfor line in sys.stdin:\n    print(line.strip().upper())",
            stdin="alpha\nbeta\n",
        )
        assert result.succeeded
        assert "ALPHA" in result.stdout and "BETA" in result.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node interpreter not on PATH")
class TestNodeExecution:
    def test_node_print_captured(self) -> None:
        result = run_snippet("console.log('hi from node')", language="node")
        assert result.succeeded
        assert "hi from node" in result.stdout
        assert result.language is PlaygroundLanguage.NODE


# ---------------------------------------------------------------------------
# Timeouts


class TestTimeout:
    def test_timeout_raises_playground_timeout(self) -> None:
        runner = PlaygroundRunner(timeout_seconds=0.5)
        with pytest.raises(PlaygroundTimeout):
            runner.run("import time\ntime.sleep(5)")

    def test_under_timeout_completes_normally(self) -> None:
        runner = PlaygroundRunner(timeout_seconds=5.0)
        result = runner.run("print('quick')")
        assert result.succeeded
        assert result.duration_seconds < 5.0


# ---------------------------------------------------------------------------
# Output capping


class TestOutputCap:
    def test_cap_output_returns_short_input_unchanged(self) -> None:
        out, truncated = _cap_output("hello")
        assert out == "hello"
        assert truncated is False

    def test_cap_output_truncates_when_over_limit(self) -> None:
        big = "x" * (DEFAULT_OUTPUT_CAP_BYTES + 100)
        out, truncated = _cap_output(big)
        assert truncated is True
        assert TRUNCATION_MARKER in out
        # Must be at most cap + marker length.
        assert len(out.encode("utf-8")) <= DEFAULT_OUTPUT_CAP_BYTES + len(
            TRUNCATION_MARKER.encode("utf-8")
        )

    def test_huge_stdout_marked_truncated(self) -> None:
        # 350 KB of output → must be capped (default cap = 256 KiB).
        snippet = (
            "import sys\nsys.stdout.write('x' * (350 * 1024))\nsys.stdout.flush()\n"
        )
        result = PlaygroundRunner(timeout_seconds=15).run(snippet)
        assert result.succeeded
        assert result.truncated is True
        assert TRUNCATION_MARKER in result.stdout


# ---------------------------------------------------------------------------
# Sandbox isolation


class TestSandboxIsolation:
    def test_default_cwd_is_isolated(self) -> None:
        # Snippet writes a file to cwd; after the run, that cwd is gone.
        snippet = (
            "import os\n"
            "with open('marker.txt', 'w') as f:\n"
            "    f.write('written')\n"
            "print(os.getcwd())\n"
        )
        result = run_snippet(snippet)
        assert result.succeeded
        cwd_used = result.stdout.strip().splitlines()[-1]
        # The snippet's cwd should be cleaned up after the run.
        assert not Path(cwd_used).exists()

    def test_explicit_cwd_is_not_cleaned(self, tmp_path: Path) -> None:
        runner = PlaygroundRunner(cwd=tmp_path)
        result = runner.run("with open('artifact.txt', 'w') as f: f.write('ok')")
        assert result.succeeded
        # Caller-provided cwd is left intact (caller owns its lifecycle).
        assert (tmp_path / "artifact.txt").read_text(encoding="utf-8") == "ok"

    def test_env_is_minimal_by_default(self) -> None:
        # A made-up env var should not leak from the parent process.
        import os

        os.environ["WORKPILOT_PLAYGROUND_LEAK_PROBE"] = "should_not_leak"
        try:
            result = run_snippet(
                "import os\nprint(os.environ.get('WORKPILOT_PLAYGROUND_LEAK_PROBE', '__missing__'))"
            )
        finally:
            os.environ.pop("WORKPILOT_PLAYGROUND_LEAK_PROBE", None)
        assert "__missing__" in result.stdout

    def test_explicit_env_passed_through(self) -> None:
        runner = PlaygroundRunner(env={"PLAYGROUND_GREETING": "ahoy"})
        result = runner.run(
            "import os\nprint(os.environ.get('PLAYGROUND_GREETING', 'none'))"
        )
        assert "ahoy" in result.stdout


# ---------------------------------------------------------------------------
# Misuse / error surfaces


class TestErrorHandling:
    def test_unknown_language_string_raises_value_error(self) -> None:
        with pytest.raises(ValueError):
            run_snippet("print(1)", language="haskell")

    def test_missing_interpreter_raises_runtime_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Simulate "node not installed" by making _resolve_executable miss.
        from code_playground import runner as runner_mod

        monkeypatch.setattr(runner_mod, "_resolve_executable", lambda _lang: None)
        with pytest.raises(RuntimeError, match="No interpreter"):
            run_snippet("print(1)", language="python")


# ---------------------------------------------------------------------------
# Result serialization


class TestResultSerialization:
    def test_to_dict_round_trip(self) -> None:
        r = PlaygroundResult(
            language=PlaygroundLanguage.PYTHON,
            exit_code=0,
            stdout="o",
            stderr="e",
            duration_seconds=0.123,
            truncated=False,
            extra={"k": "v"},
        )
        d = r.to_dict()
        assert d["language"] == "python"
        assert d["succeeded"] is True
        assert d["extra"] == {"k": "v"}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
