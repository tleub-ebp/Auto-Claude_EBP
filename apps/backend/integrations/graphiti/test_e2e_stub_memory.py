#!/usr/bin/env python3
"""
E2E Validation of the Graphiti Memory Chain (no Ollama required)
================================================================

Validates the full production memory path used by the kanban pipeline:

    save_session_memory()  -> GraphitiMemory -> LadybugDB (embedded)
    get_graphiti_context() -> GraphitiSearch -> retrieved context

Instead of a live Ollama server, this script starts a local HTTP stub that
implements the OpenAI-compatible endpoints Ollama exposes:

    POST /v1/embeddings        -> deterministic pseudo-embeddings
    POST /v1/chat/completions  -> minimal valid instance of the requested
                                  json_schema (entity extraction returns
                                  empty lists, which graphiti accepts)

This exercises the exact same code path as a real Ollama setup
(GRAPHITI_LLM_PROVIDER=ollama + GRAPHITI_EMBEDDER_PROVIDER=ollama),
so it can run in CI without downloading models.

Usage:
    cd apps/backend
    python integrations/graphiti/test_e2e_stub_memory.py
"""

import asyncio
import hashlib
import json
import math
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Add backend root to path (same pattern as sibling test scripts)
backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

EMBEDDING_DIM = 768


def minimal_instance(schema: dict, defs: dict | None = None):
    """Build a minimal valid instance of a JSON schema."""
    if defs is None:
        defs = schema.get("$defs", {})

    if "$ref" in schema:
        ref_name = schema["$ref"].split("/")[-1]
        return minimal_instance(defs.get(ref_name, {}), defs)

    if "default" in schema:
        return schema["default"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][0]
    if "anyOf" in schema and schema["anyOf"]:
        return minimal_instance(schema["anyOf"][0], defs)

    schema_type = schema.get("type")
    if schema_type == "object" or "properties" in schema:
        required = set(schema.get("required", []))
        return {
            name: minimal_instance(prop, defs)
            for name, prop in schema.get("properties", {}).items()
            if name in required
        }
    if schema_type == "array":
        return []
    if schema_type == "string":
        return ""
    if schema_type in ("integer", "number"):
        return 0
    if schema_type == "boolean":
        return False
    return None


def fake_embedding(text: str) -> list[float]:
    """Deterministic unit-norm embedding derived from the text hash."""
    seed = hashlib.sha256(text.encode("utf-8", errors="replace")).digest()
    values = []
    counter = 0
    while len(values) < EMBEDDING_DIM:
        block = hashlib.sha256(seed + counter.to_bytes(4, "little")).digest()
        values.extend(b / 255.0 - 0.5 for b in block)
        counter += 1
    values = values[:EMBEDDING_DIM]
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


class StubHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible stub for Ollama's /v1 endpoints."""

    def log_message(self, fmt, *args):  # silence request logging
        pass

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")

        if self.path.endswith("/embeddings"):
            inputs = request.get("input", [])
            if isinstance(inputs, str):
                inputs = [inputs]
            self._send_json(
                {
                    "object": "list",
                    "data": [
                        {
                            "object": "embedding",
                            "index": i,
                            "embedding": fake_embedding(str(text)),
                        }
                        for i, text in enumerate(inputs)
                    ],
                    "model": request.get("model", "stub"),
                    "usage": {"prompt_tokens": 0, "total_tokens": 0},
                }
            )
            return

        if self.path.endswith("/chat/completions"):
            response_format = request.get("response_format", {})
            schema = response_format.get("json_schema", {}).get("schema")
            content = minimal_instance(schema) if schema else {}
            self._send_json(
                {
                    "id": "stub",
                    "object": "chat.completion",
                    "model": request.get("model", "stub"),
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": json.dumps(content),
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                        "total_tokens": 0,
                    },
                }
            )
            return

        self._send_json({"error": f"unhandled path {self.path}"}, status=404)


def start_stub_server() -> tuple[ThreadingHTTPServer, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


async def run_validation(base_url: str, work_dir: Path) -> int:
    project_dir = work_dir / "project"
    spec_dir = project_dir / "specs" / "001-e2e-validation"
    spec_dir.mkdir(parents=True)

    os.environ.update(
        {
            "GRAPHITI_ENABLED": "true",
            "GRAPHITI_LLM_PROVIDER": "ollama",
            "GRAPHITI_EMBEDDER_PROVIDER": "ollama",
            "OLLAMA_BASE_URL": base_url,
            "OLLAMA_LLM_MODEL": "stub-llm",
            "OLLAMA_EMBEDDING_MODEL": "nomic-embed-text",
            "OLLAMA_EMBEDDING_DIM": str(EMBEDDING_DIM),
            "GRAPHITI_DB_PATH": str(work_dir / "memories"),
            "GRAPHITI_DATABASE": "e2e_validation",
        }
    )

    from agents.memory_manager import get_graphiti_context, save_session_memory

    failures = 0

    # 1. Save session memory through the production entry point
    discoveries = {
        "files_understood": {
            "src/api/auth.py": "JWT authentication handler with refresh tokens"
        },
        "patterns_found": ["Always validate JWT expiry before refreshing tokens"],
        "gotchas_encountered": [
            "Token refresh endpoint requires the legacy session cookie"
        ],
    }
    saved, storage = await save_session_memory(
        spec_dir,
        project_dir,
        subtask_id="subtask-1",
        session_num=1,
        success=True,
        subtasks_completed=["subtask-1"],
        discoveries=discoveries,
    )
    print(f"save_session_memory -> saved={saved}, storage={storage}")
    if not saved or storage != "graphiti":
        print("FAIL: insights were not persisted to Graphiti")
        failures += 1

    # 2. Save a pattern and a gotcha (the learning-loop episode types)
    from memory.graphiti_helpers import get_graphiti_memory

    memory = await get_graphiti_memory(spec_dir, project_dir)
    if memory is None:
        print("FAIL: GraphitiMemory unavailable for pattern/gotcha save")
        failures += 1
    else:
        try:
            pattern_ok = await memory.save_pattern(
                "Always validate JWT expiry before refreshing tokens"
            )
            gotcha_ok = await memory.save_gotcha(
                "Token refresh endpoint requires the legacy session cookie"
            )
            patterns, gotchas = await memory.get_patterns_and_gotchas(
                "JWT authentication token refresh", num_results=3, min_score=0.5
            )
            print(
                f"save_pattern={pattern_ok}, save_gotcha={gotcha_ok}, "
                f"retrieved {len(patterns)} pattern(s), {len(gotchas)} gotcha(s)"
            )
            if not (pattern_ok and gotcha_ok and patterns and gotchas):
                print("FAIL: pattern/gotcha round-trip failed")
                failures += 1
        finally:
            await memory.close()

    # 3. Retrieve context for a related subtask (production retrieval path)
    context = await get_graphiti_context(
        spec_dir,
        project_dir,
        subtask={
            "id": "subtask-2",
            "description": "Improve JWT authentication token refresh handling",
        },
    )
    print(
        f"get_graphiti_context -> {'<none>' if context is None else f'{len(context)} chars'}"
    )
    if context:
        preview = "\n".join(context.splitlines()[:20])
        print("--- context preview ---")
        print(preview)
        print("-----------------------")
    if not context or "session" not in context.lower():
        print("FAIL: no usable context retrieved from Graphiti")
        failures += 1

    return failures


def _run_with_stub() -> int:
    server, port = start_stub_server()
    base_url = f"http://127.0.0.1:{port}"
    print(f"Stub Ollama server listening on {base_url}")
    try:
        with tempfile.TemporaryDirectory(prefix="graphiti_e2e_") as tmp:
            return asyncio.run(run_validation(base_url, Path(tmp)))
    finally:
        server.shutdown()


def test_graphiti_memory_chain_with_stub():
    """
    Pytest entry point: exercises save + retrieval through the real Graphiti
    stack (LadybugDB embedded driver) using a stub Ollama server, so it runs
    in CI without any external service. Skips if the embedded DB isn't present.

    Marked `stubbed_e2e` so the directory-wide external-service skip in
    conftest.py does not apply to it.
    """
    import pytest

    try:
        import graphiti_core  # noqa: F401
        import real_ladybug  # noqa: F401
    except ImportError as e:  # pragma: no cover - depends on environment
        pytest.skip(f"Graphiti embedded stack not installed: {e}")

    failures = _run_with_stub()
    assert failures == 0, f"{failures} memory-chain check(s) failed"


# Mark applied at module import so conftest can detect and exempt this test.
test_graphiti_memory_chain_with_stub.stubbed_e2e = True


def main() -> int:
    failures = _run_with_stub()
    if failures:
        print(f"\nE2E validation FAILED ({failures} check(s) failed)")
        return 1
    print("\nE2E validation PASSED: save + retrieval both went through Graphiti")
    return 0


if __name__ == "__main__":
    sys.exit(main())
