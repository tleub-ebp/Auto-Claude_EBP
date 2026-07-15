"""Test Generation Runner

CLI entry point for test generation actions. Spawned by the Electron frontend
as a child process. Prints structured output lines for IPC parsing.

Output protocol:
  - Lines NOT starting with __ are status/progress messages forwarded to UI.
  - __TEST_GENERATION_RESULT__:<json>  — success payload for analyze-coverage
  - __TEST_GENERATION_RESULT__:<json>  — success payload for generate-* actions
  - __TEST_GENERATION_ERROR__:<message> — error payload

Usage:
  python runners/test_generation_runner.py --action analyze-coverage --file-path /path/to/file.ts --project-path /path/to/project
  python runners/test_generation_runner.py --action generate-unit --file-path /path/to/file.py --project-path /path/to/project
  python runners/test_generation_runner.py --action generate-e2e --user-story "..." --target-module mymodule --project-path /path/to/project
  python runners/test_generation_runner.py --action generate-tdd --description "..." --language typescript --snippet-type function --project-path /path/to/project
"""

import argparse
import dataclasses
import json
import os
import sys
from pathlib import Path

# Ensure the backend root (parent of 'runners/') is on sys.path so that
# 'agents', 'services', etc. are importable regardless of how the script is invoked.
_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)


def _serialize(obj):
    """Recursively convert dataclasses and other types to JSON-serialisable dicts."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _serialize(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, list):
        return [_serialize(i) for i in obj]
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    return obj


def _print_result(payload: dict) -> None:
    print(f"__TEST_GENERATION_RESULT__:{json.dumps(payload)}", flush=True)


def _print_error(message: str) -> None:
    print(f"__TEST_GENERATION_ERROR__:{message}", flush=True)


def _status(message: str) -> None:
    print(message, flush=True)


def _emit_event(event: dict) -> None:
    """Emit a structured live-progress event for the UI.

    One JSON object per line, prefixed with ``__TG_EVENT__:``. ``json.dumps``
    escapes newlines inside string values, so a ``code`` delta spanning several
    lines still arrives as a single stdout line (the frontend splits on '\\n').
    """
    try:
        print(f"__TG_EVENT__:{json.dumps(event, ensure_ascii=False)}", flush=True)
    except Exception:  # noqa: BLE001 — progress reporting must never abort a run
        pass


def _write_test_file(
    result, project_path: str | None, source_file_path: str | None = None
) -> None:
    """Resolve and write the generated test file to disk. Updates result.test_file_path."""
    content: str = getattr(result, "test_file_content", "")
    raw_path: str = getattr(result, "test_file_path", "")

    if not content or not raw_path:
        return

    resolved = Path(raw_path)
    if not resolved.is_absolute():
        if project_path:
            resolved = Path(project_path) / raw_path
        elif source_file_path:
            resolved = Path(source_file_path).parent / raw_path
        else:
            resolved = resolved.resolve()

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")
    result.test_file_path = str(resolved)
    _status(f"Test file written: {resolved}")


# ── Action handlers ──────────────────────────────────────────────────


def _run_analyze_coverage(agent, args) -> None:
    if not args.file_path:
        _print_error("--file-path is required for analyze-coverage")
        sys.exit(1)

    _status(f"Analyzing test coverage for: {args.file_path}")
    try:
        gaps = agent.analyze_coverage(
            args.file_path,
            existing_test_path=args.existing_test_path,
            project_path=args.project_path,
        )
        _status(f"Found {len(gaps)} coverage gap(s)")
        _print_result({"success": True, "gaps": _serialize(gaps)})
    except Exception as exc:  # noqa: BLE001
        _print_error(str(exc))
        sys.exit(1)


def _run_generate_unit(agent, args) -> None:
    if not args.file_path:
        _print_error("--file-path is required for generate-unit")
        sys.exit(1)

    _status(f"Generating unit tests for: {args.file_path}")
    try:
        result = agent.generate_unit_tests(
            args.file_path,
            existing_test_path=args.existing_test_path,
            max_tests_per_function=3,
            project_path=args.project_path,
            on_event=_emit_event,
        )
        _status(f"Generated {result.tests_generated} test(s)")
        _emit_event({"type": "stage", "stage": "write"})
        _write_test_file(result, args.project_path, args.file_path)
        _emit_event(
            {
                "type": "stage",
                "stage": "done",
                "status": "done",
                "path": result.test_file_path,
                "tests": result.tests_generated,
            }
        )
        _print_result({"success": True, "result": _serialize(result)})
    except Exception as exc:  # noqa: BLE001
        _print_error(str(exc))
        sys.exit(1)


def _run_generate_e2e(agent, args) -> None:
    if not args.user_story:
        _print_error("--user-story is required for generate-e2e")
        sys.exit(1)
    if not args.target_module:
        _print_error("--target-module is required for generate-e2e")
        sys.exit(1)

    _status(f"Generating E2E tests for module: {args.target_module}")
    try:
        result = agent.generate_tests_from_user_story(
            args.user_story,
            args.target_module,
            project_path=args.project_path,
            on_event=_emit_event,
        )
        _status(f"Generated {result.tests_generated} E2E test(s)")
        _emit_event({"type": "stage", "stage": "write"})
        _write_test_file(result, args.project_path, args.target_module or None)
        _emit_event(
            {
                "type": "stage",
                "stage": "done",
                "status": "done",
                "path": result.test_file_path,
                "tests": result.tests_generated,
            }
        )
        _print_result({"success": True, "result": _serialize(result)})
    except Exception as exc:  # noqa: BLE001
        _print_error(str(exc))
        sys.exit(1)


def _run_generate_tdd(agent, args) -> None:
    if not args.description:
        _print_error("--description is required for generate-tdd")
        sys.exit(1)

    _status(f"Generating TDD tests: {args.description[:60]}")

    spec: dict = {
        "name": args.snippet_type,
        "description": args.description,
        "language": args.language,
        "snippet_type": args.snippet_type,
        "module": "",
        "args": [],
        "returns": "Any",
        "edge_cases": [],
    }

    try:
        result = agent.generate_tdd_tests(
            spec, project_path=args.project_path, on_event=_emit_event
        )
        _status(f"Generated {result.tests_generated} TDD test(s)")
        _emit_event({"type": "stage", "stage": "write"})
        _write_test_file(result, args.project_path)
        _emit_event(
            {
                "type": "stage",
                "stage": "done",
                "status": "done",
                "path": result.test_file_path,
                "tests": result.tests_generated,
            }
        )
        _print_result({"success": True, "result": _serialize(result)})
    except Exception as exc:  # noqa: BLE001
        _print_error(str(exc))
        sys.exit(1)


# ── Entry point ──────────────────────────────────────────────────────

_ACTION_HANDLERS = {
    "analyze-coverage": _run_analyze_coverage,
    "generate-unit": _run_generate_unit,
    "generate-e2e": _run_generate_e2e,
    "generate-tdd": _run_generate_tdd,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Test Generation Runner")
    parser.add_argument(
        "--action",
        required=True,
        choices=list(_ACTION_HANDLERS),
        help="Action to perform",
    )
    parser.add_argument("--file-path", default=None, help="Path to source file")
    parser.add_argument(
        "--existing-test-path", default=None, help="Path to existing test file"
    )
    parser.add_argument(
        "--coverage-target",
        type=int,
        default=80,
        help="Coverage target percentage (default: 80)",
    )
    parser.add_argument(
        "--user-story", default=None, help="User story text for E2E generation"
    )
    parser.add_argument(
        "--target-module", default=None, help="Module/file to test for E2E"
    )
    parser.add_argument(
        "--description", default=None, help="Function description for TDD"
    )
    parser.add_argument(
        "--language", default="python", help="Programming language for TDD"
    )
    parser.add_argument(
        "--snippet-type", default="function", help="Snippet type for TDD"
    )
    parser.add_argument(
        "--project-path",
        default=None,
        help="Root path of the project (used to detect language and test framework)",
    )

    args = parser.parse_args()

    try:
        from agents.test_generator import TestGeneratorAgent
    except ImportError as exc:
        _print_error(f"Failed to import TestGeneratorAgent: {exc}")
        sys.exit(1)

    agent = TestGeneratorAgent()
    _ACTION_HANDLERS[args.action](agent, args)


if __name__ == "__main__":
    main()
