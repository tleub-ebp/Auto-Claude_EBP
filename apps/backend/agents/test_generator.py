"""Test Generator Agent — LLM-powered test generation for any language.

Uses Claude to analyse source files and generate comprehensive test suites,
detecting the project's language and test framework automatically from
package.json, pyproject.toml, .csproj, pom.xml, etc.

Supported languages: Python, TypeScript, JavaScript, C#, Java, Go, Ruby, etc.

Example:
    >>> agent = TestGeneratorAgent()
    >>> gaps = agent.analyze_coverage("src/utils/calculator.ts", project_path="/my/project")
    >>> result = agent.generate_unit_tests("src/utils/calculator.ts", project_path="/my/project")
"""

import ast
import asyncio
import json
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_TEST_GEN_SYSTEM_PROMPT = (
    "You are a senior test engineer. Follow the user's instructions exactly and "
    "return only the requested raw JSON object — no markdown fences, no prose."
)

# An event emitted during a streaming generation run. ``type`` is either
# ``"stage"`` (pipeline step: detect / read / generate / write / done, with an
# optional human ``detail``) or ``"code"`` (a chunk of *clean*, un-escaped test
# file content for live display).
GenEvent = dict[str, Any]


def _decode_json_string_prefix(raw: str, start: int) -> tuple[str, bool]:
    """Decode a JSON string body beginning at ``start`` (just past the opening quote).

    Returns ``(decoded_so_far, closed)`` where ``closed`` becomes True once the
    terminating unescaped quote is reached. A trailing *incomplete* escape (a
    lone ``\\`` or a partial ``\\uXXXX``) is held back so a half-arrived chunk
    never yields a broken character — the next chunk completes it.
    """
    esc = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        "b": "\b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
    }
    out: list[str] = []
    i, n = start, len(raw)
    while i < n:
        c = raw[i]
        if c == "\\":
            if i + 1 >= n:
                break  # incomplete escape — wait for more
            nxt = raw[i + 1]
            if nxt == "u":
                if i + 6 > n:
                    break  # incomplete \uXXXX — wait for more
                try:
                    out.append(chr(int(raw[i + 2 : i + 6], 16)))
                except ValueError:
                    out.append(raw[i : i + 6])
                i += 6
                continue
            out.append(esc.get(nxt, nxt))
            i += 2
            continue
        if c == '"':
            return "".join(out), True
        out.append(c)
        i += 1
    return "".join(out), False


class StreamingJsonFieldExtractor:
    """Incrementally decode one string field of a JSON object as it streams in.

    The test-generation prompts ask the model for a JSON object whose
    ``test_file_content`` holds the whole test file as an *escaped* string.
    Forwarding the raw JSON to the UI would surface ugly ``\\n`` escapes, so this
    scanner locates the field and un-escapes it on the fly, returning only the
    newly-decoded characters on each :meth:`feed` — a clean, live "typing" stream
    no matter how the provider chunks its output.

    Fail-safe: if the field never appears (malformed output) it simply yields
    nothing and the caller falls back to the fully-parsed final result.
    """

    def __init__(self, field_name: str = "test_file_content") -> None:
        self._needle = f'"{field_name}"'
        self._raw = ""
        self._content_start = -1  # index just past the opening quote, once found
        self._emitted = 0  # count of decoded chars already returned
        self._closed = False

    def feed(self, chunk: str) -> str:
        """Append ``chunk`` and return any newly-decoded field characters."""
        if self._closed or not chunk:
            return ""
        self._raw += chunk
        if self._content_start < 0:
            self._locate_start()
            if self._content_start < 0:
                return ""
        decoded, closed = _decode_json_string_prefix(self._raw, self._content_start)
        self._closed = closed
        if len(decoded) <= self._emitted:
            return ""
        new = decoded[self._emitted :]
        self._emitted = len(decoded)
        return new

    def _locate_start(self) -> None:
        key = self._raw.find(self._needle)
        if key < 0:
            return
        i, n = key + len(self._needle), len(self._raw)
        while i < n and self._raw[i] in " \t\r\n":
            i += 1
        if i >= n or self._raw[i] != ":":
            return
        i += 1
        while i < n and self._raw[i] in " \t\r\n":
            i += 1
        if i >= n or self._raw[i] != '"':
            return  # value isn't a string, or the opening quote hasn't arrived
        self._content_start = i + 1


def _slice_test_block(content: str, test_name: str, language: str) -> str:
    """Best-effort: extract the source block of a single test from a test file.

    Used to fill each ``GeneratedTest.test_code`` (previously always empty, which
    rendered as blank boxes in the UI). Brace languages use brace matching;
    Python uses indentation. Returns ``""`` when the test can't be located so the
    caller degrades gracefully rather than showing garbage.
    """
    if not content or not test_name:
        return ""
    idx = content.find(test_name)
    if idx < 0:
        return ""
    line_start = content.rfind("\n", 0, idx) + 1

    if language == "python":
        lines = content[line_start:].split("\n")
        first = lines[0]
        indent = len(first) - len(first.lstrip())
        kept = [first]
        for ln in lines[1:]:
            if ln.strip() == "":
                kept.append(ln)
                continue
            if (len(ln) - len(ln.lstrip())) <= indent:
                break
            kept.append(ln)
        return "\n".join(kept).rstrip() + "\n"

    brace = content.find("{", idx)
    if brace < 0:
        return ""
    depth = 0
    for i in range(brace, len(content)):
        ch = content[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return content[line_start : i + 1].rstrip() + "\n"
    return ""


# ── Data models ─────────────────────────────────────────────────────


@dataclass
class FunctionInfo:
    """Information about a function/method extracted from source code."""

    name: str
    module: str
    class_name: str | None = None
    args: list[str] = field(default_factory=list)
    return_type: str | None = None
    docstring: str = ""
    line_number: int = 0
    is_async: bool = False
    decorators: list[str] = field(default_factory=list)
    complexity: int = 1

    @property
    def full_name(self) -> str:
        if self.class_name:
            return f"{self.class_name}.{self.name}"
        return self.name

    @property
    def is_private(self) -> bool:
        return self.name.startswith("_") and not self.name.startswith("__")

    @property
    def is_dunder(self) -> bool:
        return self.name.startswith("__") and self.name.endswith("__")


@dataclass
class CoverageGap:
    """Represents a gap in test coverage."""

    function: FunctionInfo
    priority: str = "medium"
    reason: str = ""
    suggested_test_count: int = 1


@dataclass
class GeneratedTest:
    """A generated test case."""

    test_name: str
    test_code: str
    target_function: str
    test_type: str = "unit"
    description: str = ""
    imports: list[str] = field(default_factory=list)
    fixtures: list[str] = field(default_factory=list)


@dataclass
class TestGenerationResult:
    """Result of a test generation run."""

    source_file: str
    functions_analyzed: int = 0
    tests_generated: int = 0
    coverage_gaps: list[CoverageGap] = field(default_factory=list)
    generated_tests: list[GeneratedTest] = field(default_factory=list)
    test_file_content: str = ""
    test_file_path: str = ""

    # Prevent pytest from collecting this as a test class
    __test__ = False


# ── Project analyser ────────────────────────────────────────────────


class ProjectAnalyzer:
    """Detects project language and test framework from config files."""

    EXTENSION_TO_LANGUAGE: dict[str, str] = {
        ".py": "python",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".cs": "csharp",
        ".java": "java",
        ".rb": "ruby",
        ".go": "go",
        ".rs": "rust",
        ".kt": "kotlin",
        ".kts": "kotlin",
        ".swift": "swift",
        ".php": "php",
        ".vue": "javascript",
        ".svelte": "javascript",
    }

    def detect(
        self,
        file_path: str,
        project_path: str | None = None,
    ) -> dict[str, str]:
        """Detect language and test framework for a source file.

        Args:
            file_path: Path to the source file.
            project_path: Optional explicit project root. When None, walks up
                the directory tree looking for config file markers.

        Returns:
            Dict with keys ``language``, ``test_framework``, ``project_root``,
            ``details``.
        """
        ext = Path(file_path).suffix.lower()
        language = self.EXTENSION_TO_LANGUAGE.get(ext, "unknown")

        root = project_path or self._find_project_root(file_path)

        if root:
            framework, details = self._scan_framework(root, language)
        else:
            framework = self._default_framework(language)
            details = ""

        return {
            "language": language,
            "test_framework": framework,
            "project_root": root or str(Path(file_path).parent),
            "details": details,
        }

    def _find_project_root(self, file_path: str) -> str | None:
        """Walk up from the file to find the project root."""
        markers = [
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "Cargo.toml",
            "go.mod",
            ".git",
        ]
        current = Path(file_path).resolve().parent
        for _ in range(7):
            for marker in markers:
                if (current / marker).exists():
                    return str(current)
            parent = current.parent
            if parent == current:
                break
            current = parent
        return None

    def _scan_framework(self, project_root: str, language: str) -> tuple[str, str]:
        """Scan config files to detect the test framework in use."""
        root = Path(project_root)
        for detector in (
            self._detect_js_framework,
            self._detect_python_framework,
            self._detect_java_framework,
            self._detect_csharp_framework,
            self._detect_ruby_framework,
        ):
            result = detector(root, language)
            if result:
                return result
        return self._default_framework(language), ""

    def _detect_js_framework(self, root: Path, language: str) -> tuple[str, str] | None:
        pkg_json = root / "package.json"
        if not pkg_json.exists():
            return None
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
            deps: dict[str, str] = {
                **pkg.get("dependencies", {}),
                **pkg.get("devDependencies", {}),
            }
            for fw, dep in [
                ("vitest", "vitest"),
                ("jest", "jest"),
                ("mocha", "mocha"),
                ("jasmine", "jasmine"),
                ("playwright", "@playwright/test"),
                ("cypress", "cypress"),
            ]:
                if dep in deps:
                    return fw, f"{dep} {deps[dep]}"
            if language in ("typescript", "javascript"):
                return "jest", "(no test framework detected in package.json)"
        except Exception:
            pass
        return None

    def _detect_python_framework(
        self,
        root: Path,
        language: str,  # noqa: ARG002
    ) -> tuple[str, str] | None:
        for fname in (
            "requirements.txt",
            "requirements-dev.txt",
            "requirements-test.txt",
        ):
            req_path = root / fname
            if req_path.exists():
                try:
                    content = req_path.read_text(encoding="utf-8").lower()
                    if "pytest" in content:
                        return "pytest", f"pytest ({fname})"
                    if "nose2" in content:
                        return "nose2", f"nose2 ({fname})"
                except Exception:
                    pass
        pyproject = root / "pyproject.toml"
        if pyproject.exists():
            try:
                content = pyproject.read_text(encoding="utf-8").lower()
                if "pytest" in content:
                    return "pytest", "pytest (pyproject.toml)"
                if "unittest" in content:
                    return "unittest", "unittest (pyproject.toml)"
            except Exception:
                pass
        return None

    def _detect_java_framework(
        self,
        root: Path,
        language: str,  # noqa: ARG002
    ) -> tuple[str, str] | None:
        pom = root / "pom.xml"
        if pom.exists():
            try:
                content = pom.read_text(encoding="utf-8")
                lower = content.lower()
                if "junit" in lower:
                    if "junit-jupiter" in content or "org.junit.jupiter" in content:
                        return "junit5", "JUnit 5 (pom.xml)"
                    return "junit4", "JUnit 4 (pom.xml)"
                if "testng" in lower:
                    return "testng", "TestNG (pom.xml)"
            except Exception:
                pass
        for gradle_file in ("build.gradle", "build.gradle.kts"):
            gradle = root / gradle_file
            if gradle.exists():
                try:
                    if "junit" in gradle.read_text(encoding="utf-8").lower():
                        return "junit5", f"JUnit ({gradle_file})"
                except Exception:
                    pass
        return None

    def _detect_csharp_framework(
        self,
        root: Path,
        language: str,  # noqa: ARG002
    ) -> tuple[str, str] | None:
        try:
            for entry in root.iterdir():
                if entry.is_file() and entry.suffix == ".csproj":
                    try:
                        content = entry.read_text(encoding="utf-8")
                        if "NUnit" in content:
                            return "nunit", f"NUnit ({entry.name})"
                        if "xunit" in content.lower():
                            return "xunit", f"xUnit ({entry.name})"
                        if "MSTest" in content:
                            return "mstest", f"MSTest ({entry.name})"
                    except Exception:
                        pass
        except Exception:
            pass
        return None

    def _detect_ruby_framework(
        self,
        root: Path,
        language: str,  # noqa: ARG002
    ) -> tuple[str, str] | None:
        gemfile = root / "Gemfile"
        if not gemfile.exists():
            return None
        try:
            content = gemfile.read_text(encoding="utf-8").lower()
            if "rspec" in content:
                return "rspec", "RSpec (Gemfile)"
            if "minitest" in content:
                return "minitest", "Minitest (Gemfile)"
        except Exception:
            pass
        return None

    def default_framework(self, language: str) -> str:
        """Return the conventional default test framework for a language."""
        return self._default_framework(language)

    def _default_framework(self, language: str) -> str:
        defaults: dict[str, str] = {
            "python": "pytest",
            "typescript": "jest",
            "javascript": "jest",
            "csharp": "xunit",
            "java": "junit5",
            "go": "testing",
            "rust": "built-in",
            "ruby": "rspec",
            "kotlin": "junit5",
            "swift": "xctest",
            "php": "phpunit",
        }
        return defaults.get(language, "unknown")


# ── Code analyzer ────────────────────────────────────────────────────


class CodeAnalyzer:
    """Analyzes source code to extract function information."""

    def analyze_source(self, source: str, module: str) -> list[FunctionInfo]:
        """Analyze source code and extract function information."""
        if not source or not source.strip():
            return []

        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []

        functions = []

        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                # Process methods within this class
                for child in node.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        func_info = self._extract_function_info(
                            child, module, node.name
                        )
                        if func_info:
                            functions.append(func_info)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # Only process standalone functions (not methods)
                # Check if this function is directly under module level
                parent = self._find_parent_node(tree, node)
                if not isinstance(parent, ast.ClassDef):
                    func_info = self._extract_function_info(node, module)
                    if func_info:
                        functions.append(func_info)

        return functions

    def _find_parent_node(self, tree: ast.AST, target_node: ast.AST) -> ast.AST | None:
        """Find the direct parent of target_node in the AST."""
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                if child is target_node:
                    return node
        return None

    def _extract_function_info(
        self,
        node: "ast.FunctionDef | ast.AsyncFunctionDef",
        module: str,
        class_name: str | None = None,
    ) -> FunctionInfo | None:
        """Extract function information from AST node."""

        # Get basic info
        name = node.name
        args = []
        return_type = None
        docstring = ast.get_docstring(node) or ""
        line_number = node.lineno
        is_async = isinstance(node, ast.AsyncFunctionDef)
        decorators = [d.id for d in node.decorator_list if isinstance(d, ast.Name)]

        # Extract arguments (exclude self/cls for methods)
        for i, arg in enumerate(node.args.args):
            if i == 0 and class_name and arg.arg in ("self", "cls"):
                continue  # Skip self/cls for methods
            args.append(arg.arg)

        # Get return type from annotation if available
        if node.returns:
            try:
                return_type = (
                    ast.unparse(node.returns)
                    if hasattr(ast, "unparse")
                    else str(node.returns)
                )
            except Exception:
                return_type = None

        # Calculate complexity (simplified)
        complexity = 1
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.For, ast.While, ast.Try)):
                complexity += 1

        return FunctionInfo(
            name=name,
            module=module,
            class_name=class_name,
            args=args,
            return_type=return_type,
            docstring=docstring,
            line_number=line_number,
            is_async=is_async,
            decorators=decorators,
            complexity=complexity,
        )


# ── Test generator agent ────────────────────────────────────────────


class TestGeneratorAgent:
    """LLM-powered agent that generates tests for any programming language.

    Detects the project's language and test framework automatically, then
    uses Claude to generate real, production-quality test code — not stubs.

    Example:
        >>> agent = TestGeneratorAgent()
        >>> result = agent.generate_unit_tests(
        ...     "src/utils/calculator.ts",
        ...     project_path="/path/to/project",
        ... )
        >>> print(result.test_file_content)
    """

    # Prevent pytest from collecting this as a test class
    __test__ = False

    def __init__(self, llm_provider: Any = None) -> None:
        self._project_analyzer = ProjectAnalyzer()
        # llm_provider kept for backward compatibility but not used

    # ── Public API ───────────────────────────────────────────────────

    def analyze_coverage(
        self,
        file_path: str,
        existing_test_path: str | None = None,
        project_path: str | None = None,
    ) -> list[CoverageGap]:
        """Identify functions/methods in *file_path* that lack test coverage."""
        return asyncio.run(
            self._analyze_coverage_async(file_path, existing_test_path, project_path)
        )

    def generate_unit_tests(
        self,
        file_path: str,
        existing_test_path: str | None = None,
        max_tests_per_function: int = 3,
        project_path: str | None = None,
        on_event: Callable[[GenEvent], None] | None = None,
    ) -> TestGenerationResult:
        """Generate a complete unit test file for *file_path*.

        ``on_event`` — optional callback for live progress: pipeline ``stage``
        events and ``code`` chunks as the model streams the test file (see
        :data:`GenEvent`).
        """
        return asyncio.run(
            self._generate_unit_async(
                file_path,
                existing_test_path,
                max_tests_per_function,
                project_path,
                on_event,
            )
        )

    def generate_tests_from_user_story(
        self,
        user_story: str,
        target_module: str,
        project_path: str | None = None,
        on_event: Callable[[GenEvent], None] | None = None,
    ) -> TestGenerationResult:
        """Generate E2E tests from a user story."""
        return asyncio.run(
            self._generate_e2e_async(user_story, target_module, project_path, on_event)
        )

    def generate_tdd_tests(
        self,
        spec: dict[str, Any],
        project_path: str | None = None,
        on_event: Callable[[GenEvent], None] | None = None,
    ) -> TestGenerationResult:
        """Generate failing tests (TDD red phase) based on a spec."""
        return asyncio.run(self._generate_tdd_async(spec, project_path, on_event))

    # ── Async implementations ────────────────────────────────────────

    @staticmethod
    def _emit(on_event: Callable[[GenEvent], None] | None, event: GenEvent) -> None:
        """Fire a progress event, swallowing any consumer error."""
        if on_event is None:
            return
        try:
            on_event(event)
        except Exception:  # noqa: BLE001 — progress reporting must never break generation
            logger.debug("test-gen on_event callback raised", exc_info=True)

    async def _generate_with_events(
        self,
        prompt: str,
        project_path: str | None,
        on_event: Callable[[GenEvent], None] | None,
    ) -> str:
        """Run the LLM call, emitting clean ``code`` chunks as the file streams in."""
        on_delta: Callable[[str], None] | None = None
        if on_event is not None:
            extractor = StreamingJsonFieldExtractor("test_file_content")

            def on_delta(raw: str) -> None:  # noqa: F811 — deliberate conditional binding
                clean = extractor.feed(raw)
                if clean:
                    self._emit(on_event, {"type": "code", "delta": clean})

        return await self._call_llm(prompt, project_path, on_delta=on_delta)

    async def _analyze_coverage_async(
        self, file_path: str, existing_test_path: str | None, project_path: str | None
    ) -> list[CoverageGap]:
        framework_info = self._project_analyzer.detect(file_path, project_path)
        source = self._read_file(file_path)
        if not source:
            raise FileNotFoundError(f"Cannot read source file: {file_path}")

        existing = (
            self._read_file(existing_test_path)
            if existing_test_path and os.path.exists(existing_test_path)
            else ""
        )

        print(
            f"Detected {framework_info['language']} project with {framework_info['test_framework']}",
            flush=True,
        )
        print("Asking the model to analyse coverage gaps...", flush=True)

        prompt = self._analyze_coverage_prompt(
            source, file_path, framework_info, existing
        )
        response = await self._call_llm(prompt, project_path)
        return self._parse_gaps(response, file_path, existing)

    async def _generate_unit_async(
        self,
        file_path: str,
        existing_test_path: str | None,
        max_tests_per_function: int,
        project_path: str | None,
        on_event: Callable[[GenEvent], None] | None = None,
    ) -> TestGenerationResult:
        self._emit(on_event, {"type": "stage", "stage": "detect"})
        framework_info = self._project_analyzer.detect(file_path, project_path)
        self._emit(
            on_event,
            {
                "type": "stage",
                "stage": "detect",
                "status": "done",
                "detail": f"{framework_info['language']} · {framework_info['test_framework']}",
                "language": framework_info["language"],
                "framework": framework_info["test_framework"],
            },
        )

        self._emit(on_event, {"type": "stage", "stage": "read"})
        source = self._read_file(file_path)
        if not source:
            raise FileNotFoundError(f"Cannot read source file: {file_path}")

        existing = (
            self._read_file(existing_test_path)
            if existing_test_path and os.path.exists(existing_test_path)
            else ""
        )
        self._emit(
            on_event,
            {
                "type": "stage",
                "stage": "read",
                "status": "done",
                "detail": f"{len(source.splitlines())} lignes",
            },
        )

        print(
            f"Detected {framework_info['language']} + {framework_info['test_framework']}",
            flush=True,
        )
        print("Asking the model to generate unit tests...", flush=True)

        self._emit(on_event, {"type": "stage", "stage": "generate"})
        prompt = self._generate_unit_prompt(
            source, file_path, framework_info, existing, max_tests_per_function
        )
        response = await self._generate_with_events(prompt, project_path, on_event)
        return self._parse_generation_result(
            response, file_path, "unit", framework_info
        )

    async def _generate_e2e_async(
        self,
        user_story: str,
        target_module: str,
        project_path: str | None,
        on_event: Callable[[GenEvent], None] | None = None,
    ) -> TestGenerationResult:
        self._emit(on_event, {"type": "stage", "stage": "detect"})
        # Try to detect framework from target module; fall back to project_path
        if os.path.exists(target_module):
            framework_info = self._project_analyzer.detect(target_module, project_path)
        elif project_path:
            framework_info = self._project_analyzer.detect(
                os.path.join(project_path, "dummy.ts"), project_path
            )
        else:
            framework_info = {
                "language": "unknown",
                "test_framework": "jest",
                "project_root": "",
                "details": "",
            }
        self._emit(
            on_event,
            {
                "type": "stage",
                "stage": "detect",
                "status": "done",
                "detail": f"{framework_info['language']} · {framework_info['test_framework']}",
                "language": framework_info["language"],
                "framework": framework_info["test_framework"],
            },
        )

        print(
            f"Detected {framework_info['language']} + {framework_info['test_framework']}",
            flush=True,
        )
        print("Asking the model to generate E2E tests...", flush=True)

        self._emit(on_event, {"type": "stage", "stage": "generate"})
        prompt = self._generate_e2e_prompt(user_story, target_module, framework_info)
        response = await self._generate_with_events(prompt, project_path, on_event)
        return self._parse_generation_result(
            response, target_module, "e2e", framework_info
        )

    async def _generate_tdd_async(
        self,
        spec: dict[str, Any],
        project_path: str | None,
        on_event: Callable[[GenEvent], None] | None = None,
    ) -> TestGenerationResult:
        self._emit(on_event, {"type": "stage", "stage": "detect"})
        language = spec.get("language", "python")

        # Detect framework from project if possible
        framework = self._project_analyzer.default_framework(language)
        if project_path:
            # Build a dummy file path with the right extension to trigger detection
            ext_map = {
                "typescript": ".ts",
                "javascript": ".js",
                "python": ".py",
                "csharp": ".cs",
                "java": ".java",
                "ruby": ".rb",
                "go": ".go",
                "kotlin": ".kt",
                "rust": ".rs",
            }
            ext = ext_map.get(language, f".{language[:2]}")
            dummy_path = os.path.join(project_path, f"dummy{ext}")
            detected = self._project_analyzer.detect(dummy_path, project_path)
            framework = detected.get("test_framework", framework)

        framework_info = {
            "language": language,
            "test_framework": framework,
            "project_root": project_path or "",
            "details": "",
        }
        self._emit(
            on_event,
            {
                "type": "stage",
                "stage": "detect",
                "status": "done",
                "detail": f"{language} · {framework}",
                "language": language,
                "framework": framework,
            },
        )

        print(
            f"Generating TDD tests for {language} ({framework})",
            flush=True,
        )
        print(
            "Asking the model to generate failing tests (TDD red phase)...",
            flush=True,
        )

        self._emit(on_event, {"type": "stage", "stage": "generate"})
        prompt = self._generate_tdd_prompt(spec, framework_info)
        response = await self._generate_with_events(prompt, project_path, on_event)
        spec_name = spec.get("name", "feature")
        slug = re.sub(r"[^a-z0-9_]", "_", spec_name.lower())
        return self._parse_generation_result(
            response, f"tdd_{slug}", "unit", framework_info, spec_name
        )

    # ── LLM call (provider-agnostic) ─────────────────────────────────

    async def _call_llm(
        self,
        prompt: str,
        project_path: str | None = None,
        on_delta: Callable[[str], None] | None = None,
    ) -> str:
        """Run a one-shot completion against the user's active LLM provider.

        Routes through ``core.oneshot.oneshot_completion`` so test generation
        honours the provider selected in WorkPilot (Claude / Copilot / OpenAI /
        Windsurf / Google / local) instead of hardcoding the Claude Agent SDK —
        the previous ``create_simple_client`` path silently did nothing for
        anyone not authenticated with Claude. ``project_path`` lets exotic
        providers resolve their routing from the project's ``.env``.

        ``on_delta`` — optional streaming callback forwarded to
        ``oneshot_completion``. Passed only when set so the argument surface stays
        identical to the un-instrumented call for tests that patch this path.

        Raises on failure (including an empty response) so the runner surfaces a
        clear error rather than the UI hanging on "Asking the model…".
        """
        from core.oneshot import oneshot_completion

        kwargs: dict[str, Any] = {}
        if on_delta is not None:
            kwargs["on_delta"] = on_delta
        text = await oneshot_completion(
            prompt,
            system_prompt=_TEST_GEN_SYSTEM_PROMPT,
            project_dir=project_path,
            **kwargs,
        )
        if not text or not text.strip():
            raise RuntimeError(
                "The LLM returned an empty response. Check that your AI provider "
                "is selected and authenticated in Settings."
            )
        return text

    # ── Prompts ──────────────────────────────────────────────────────

    def _analyze_coverage_prompt(
        self,
        source: str,
        file_path: str,
        framework_info: dict[str, str],
        existing: str,
    ) -> str:
        language = framework_info["language"]
        framework = framework_info["test_framework"]
        existing_section = (
            f"\n\nExisting test file (exclude already-tested functions from gaps):\n```\n{existing}\n```"
            if existing
            else ""
        )
        return f"""Analyse this {language} source file and identify which functions / methods / components lack test coverage.

Source file: {file_path}
Test framework used in this project: {framework}

Source code:
```{language}
{source}
```{existing_section}

Return ONLY a raw JSON object (no markdown, no explanation) matching this schema:
{{
  "functions_analyzed": <integer>,
  "gaps": [
    {{
      "name": "<function or method name>",
      "full_name": "<ClassName.method or bare function name>",
      "class_name": "<class name or null>",
      "line_number": <integer>,
      "priority": "<high | medium | low>",
      "reason": "<one sentence explaining why it needs tests>",
      "suggested_test_count": <integer>
    }}
  ]
}}

Priority rules:
- high  → public API / business logic / multiple branches / external I/O
- medium → helper functions, utility methods
- low   → trivial getters / setters, private helpers

Skip dunder / magic methods except __init__ when it has non-trivial logic.
Only include items NOT already covered by the existing test file."""

    def _generate_unit_prompt(
        self,
        source: str,
        file_path: str,
        framework_info: dict[str, str],
        existing: str,
        max_tests_per_function: int,
    ) -> str:
        language = framework_info["language"]
        framework = framework_info["test_framework"]
        existing_section = (
            f"\n\nExisting tests (extend, avoid duplicates):\n```\n{existing}\n```"
            if existing
            else ""
        )
        stem = Path(file_path).stem
        # Convention hints per language
        path_convention = {
            "python": f"tests/test_{stem}.py",
            "typescript": f"src/__tests__/{stem}.test.ts",
            "javascript": f"src/__tests__/{stem}.test.js",
            "csharp": f"{stem}Tests.cs",
            "java": f"{stem}Test.java",
            "go": f"{stem}_test.go",
            "ruby": f"spec/{stem}_spec.rb",
            "kotlin": f"{stem}Test.kt",
        }.get(language, f"tests/{stem}_test")

        return f"""Generate a complete, production-quality test file for this {language} source file.

Source file: {file_path}
Test framework: {framework}
Max tests per function: {max_tests_per_function}

Source code:
```{language}
{source}
```{existing_section}

Requirements:
1. Use {framework} syntax, imports, and conventions exactly as they appear in real projects.
2. Write REAL, MEANINGFUL tests — no stubs, no TODOs, no "pass".
3. Cover: happy path, edge cases, error handling, boundary values.
4. Mock / stub external dependencies (I/O, network, database) appropriately.
5. Generate up to {max_tests_per_function} tests per function.
6. Include all necessary imports at the top of the file.

Return ONLY a raw JSON object (no markdown, no explanation) matching this schema:
{{
  "test_file_content": "<complete test file as a single escaped string>",
  "test_file_path": "{path_convention}",
  "tests_generated": <integer>,
  "functions_analyzed": <integer>,
  "generated_tests": [
    {{
      "test_name": "<test name>",
      "description": "<one sentence: what this test verifies>"
    }}
  ]
}}"""

    def _generate_e2e_prompt(
        self,
        user_story: str,
        target_module: str,
        framework_info: dict[str, str],
    ) -> str:
        language = framework_info["language"]
        framework = framework_info["test_framework"]
        stem = re.sub(r"[^a-z0-9_]", "_", Path(target_module).stem.lower())

        return f"""Generate E2E / acceptance tests that verify the following user story end-to-end.

User story:
{user_story}

Target module/file: {target_module}
Test framework: {framework}
Language: {language}

Requirements:
1. Map each acceptance criterion to one or more test scenarios.
2. Use Given / When / Then structure in test descriptions.
3. Use {framework} syntax and imports.
4. Write realistic assertions, not just "expect(true).toBe(true)".

Return ONLY a raw JSON object (no markdown) matching this schema:
{{
  "test_file_content": "<complete test file as a single escaped string>",
  "test_file_path": "e2e/test_{stem}.{language == "typescript" and "ts" or language == "python" and "py" or "js"}",
  "tests_generated": <integer>,
  "functions_analyzed": 0,
  "generated_tests": [
    {{
      "test_name": "<scenario name>",
      "description": "<user story acceptance criterion covered>"
    }}
  ]
}}"""

    def _generate_tdd_prompt(
        self,
        spec: dict[str, Any],
        framework_info: dict[str, str],
    ) -> str:
        language = framework_info["language"]
        framework = framework_info["test_framework"]
        description = spec.get("description", "")
        snippet_type = spec.get("snippet_type", "function")
        slug = re.sub(r"[^a-z0-9_]", "_", description[:40].lower().strip())

        return f"""Generate failing tests for not-yet-implemented {language} code (TDD red phase).

What needs to be implemented:
{description}

Snippet type: {snippet_type}
Language: {language}
Test framework: {framework}

Requirements:
1. Tests MUST FAIL until the implementation exists — this is the TDD red phase.
2. DO NOT implement the function/class — only write tests.
3. Each test precisely documents one expected behaviour.
4. Cover: normal inputs, boundary values, invalid inputs / error conditions.
5. Use descriptive test names that serve as a living specification.
6. Import the function/class from a logical module path even though it doesn't exist yet.

Return ONLY a raw JSON object (no markdown) matching this schema:
{{
  "test_file_content": "<complete test file as a single escaped string>",
  "test_file_path": "tests/test_{slug}.{language == "python" and "py" or language in ("typescript",) and "ts" or "js"}",
  "tests_generated": <integer>,
  "functions_analyzed": 0,
  "generated_tests": [
    {{
      "test_name": "<test name>",
      "description": "<behaviour specified by this test>"
    }}
  ]
}}"""

    # ── Response parsing ─────────────────────────────────────────────

    def _parse_gaps(
        self, response: str, file_path: str, existing_test_content: str = ""
    ) -> list[CoverageGap]:
        data = self._extract_json(response)

        # An empty dict means the response wasn't parseable JSON at all (not a
        # valid object reporting zero gaps). Only then do we fall back to a
        # best-effort AST scan so the user still gets a gap list. We no longer
        # trigger this on the words "limit"/"error" appearing in the text — a
        # false positive that discarded perfectly valid model output.
        if not data:
            try:
                # Fallback: analyze source with CodeAnalyzer to create basic gaps
                source = self._read_file(file_path)
                if source:
                    analyzer = CodeAnalyzer()
                    functions = analyzer.analyze_source(source, file_path)

                    # Analyze existing tests to exclude already tested functions
                    tested_functions = set()
                    if existing_test_content:
                        tested_functions = self._extract_tested_functions(
                            existing_test_content
                        )

                    gaps = []
                    for func in functions:
                        # Create gaps for public functions only, but include __init__
                        # Exclude functions that are already tested
                        if (
                            (not func.is_private and not func.is_dunder)
                            or func.name == "__init__"
                        ) and func.name not in tested_functions:
                            gaps.append(
                                CoverageGap(
                                    function=func,
                                    priority="medium",
                                    reason="Function needs test coverage (fallback analysis)",
                                    suggested_test_count=1,
                                )
                            )
                    return gaps
            except Exception as exc:
                logger.warning("Fallback analysis failed: %s", exc)

        # Parse gaps from JSON response
        gaps: list[CoverageGap] = []
        for g in data.get("gaps", []):
            func = FunctionInfo(
                name=g.get("name", "unknown"),
                module=file_path,
                class_name=g.get("class_name"),
                line_number=g.get("line_number", 0),
            )
            gaps.append(
                CoverageGap(
                    function=func,
                    priority=g.get("priority", "medium"),
                    reason=g.get("reason", ""),
                    suggested_test_count=g.get("suggested_test_count", 1),
                )
            )
        # Surface the most important gaps first regardless of the order the model
        # emitted them (stable within a priority band).
        _rank = {"high": 0, "medium": 1, "low": 2}
        gaps.sort(key=lambda g: _rank.get(g.priority, 1))
        return gaps

    def _extract_tested_functions(self, test_content: str) -> set[str]:
        """Extract function names from existing test content."""
        tested_functions = set()
        try:
            import ast

            tree = ast.parse(test_content)
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
                    # Extract function name from test name
                    # e.g., "test_get_user_returns_expected" -> "get_user"
                    func_name = node.name[5:]  # Remove "test_" prefix
                    # Remove common suffixes
                    for suffix in [
                        "_returns_expected",
                        "_success",
                        "_error",
                        "_invalid",
                        "_valid",
                        "_test",
                    ]:
                        if func_name.endswith(suffix):
                            func_name = func_name[: -len(suffix)]
                            break
                    tested_functions.add(func_name)
        except Exception:
            # Fallback: simple regex extraction
            import re

            matches = re.findall(r"def test_(\w+)", test_content)
            for match in matches:
                func_name = match
                # Remove common suffixes
                for suffix in [
                    "_returns_expected",
                    "_success",
                    "_error",
                    "_invalid",
                    "_valid",
                    "_test",
                ]:
                    if func_name.endswith(suffix):
                        func_name = func_name[: -len(suffix)]
                        break
                tested_functions.add(func_name)
        return tested_functions

    def _parse_generation_result(
        self,
        response: str,
        file_path: str,
        test_type: str,
        framework_info: dict[str, str],
        spec_name: str | None = None,  # noqa: ARG002 — kept for call-site compatibility
    ) -> TestGenerationResult:
        data = self._extract_json(response)

        test_file_content = data.get("test_file_content", "")
        if not test_file_content:
            # No JSON envelope with a content field. Some providers reply with the
            # raw test file (no wrapper) — surface it verbatim so the user still
            # sees real generated code instead of an empty box or a fake stub.
            # Genuine provider failures never reach here: ``_call_llm`` raises on
            # an empty response, so ``response`` always carries something usable.
            # (``oneshot_completion`` already trims surrounding whitespace.)
            test_file_content = response

        tests_generated = data.get("tests_generated", 0)
        functions_analyzed = data.get("functions_analyzed", 0)

        test_file_path = data.get(
            "test_file_path",
            self._compute_test_file_path(file_path, framework_info),
        )

        # Ensure E2E tests land under an e2e/ path even if the model omitted it.
        if test_type == "e2e" and "e2e" not in test_file_path:
            stem = Path(file_path).stem.lower()
            language = framework_info.get("language", "unknown")
            ext = "py" if language == "python" else "js"
            test_file_path = f"e2e/test_{stem}.{ext}"

        language = framework_info.get("language", "")
        generated_tests = [
            GeneratedTest(
                test_name=t.get("test_name", ""),
                # Slice each test's source out of the full file so the UI can
                # show real code instead of an empty box. Best-effort: falls
                # back to "" when the block can't be located.
                test_code=_slice_test_block(
                    test_file_content, t.get("test_name", ""), language
                ),
                target_function=file_path,
                test_type=test_type,
                description=t.get("description", ""),
            )
            for t in data.get("generated_tests", [])
        ]

        # Infer the count when the model returned tests but no (or a zero) total.
        if not tests_generated and generated_tests:
            tests_generated = len(generated_tests)

        return TestGenerationResult(
            source_file=file_path,
            functions_analyzed=functions_analyzed,
            tests_generated=tests_generated,
            generated_tests=generated_tests,
            test_file_content=test_file_content,
            test_file_path=test_file_path,
        )

    def _extract_json(self, text: str) -> dict[str, Any]:
        """Extract the JSON object from an LLM response.

        Handles markdown code fences and locates the outermost ``{...}`` when the
        model wraps the object in prose. Returns an empty result structure only
        when *no* JSON can be parsed, so callers degrade gracefully.

        Note: we deliberately do **not** scan the text for words like "error",
        "limit" or "reset" to guess at a rate limit. Legitimate test code
        routinely contains those words (a feature named "limitation…", an
        error-handling test), and doing so silently discarded real generations —
        surfacing the "// Tests would be generated here" stub instead of the code
        the model actually produced. Genuine provider failures surface as
        exceptions from ``_call_llm`` (an empty response raises ``RuntimeError``),
        not as parseable JSON, so this parser never needs to second-guess them.
        """
        if not text:
            logger.error("Empty response received")
            return {}

        candidate = text

        # Strip markdown code fences
        if "```json" in candidate:
            start = candidate.find("```json") + 7
            end = candidate.find("```", start)
            if end > start:
                candidate = candidate[start:end].strip()
        elif "```" in candidate:
            start = candidate.find("```") + 3
            end = candidate.find("```", start)
            if end > start:
                candidate = candidate[start:end].strip()

        # Direct parse
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

        # Find first { ... last }
        start = candidate.find("{")
        end = candidate.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(candidate[start:end])
            except json.JSONDecodeError:
                pass

        logger.error("Failed to parse JSON from response: %.200s", text)
        # Empty dict signals "nothing parseable" — distinct from a valid object
        # that legitimately reports no gaps / no tests. Callers use ``.get()`` with
        # defaults, and ``_parse_gaps`` treats it as the cue to fall back to AST.
        return {}

    def _compute_test_file_path(
        self, source_path: str, framework_info: dict[str, str]
    ) -> str:
        language = framework_info.get("language", "python")
        stem = Path(source_path).stem
        if language == "python":
            return f"tests/test_{stem}.py"
        if language in ("typescript",):
            return f"src/__tests__/{stem}.test.ts"
        if language in ("javascript",):
            return f"src/__tests__/{stem}.test.js"
        if language == "csharp":
            return f"{stem}Tests.cs"
        if language == "java":
            return f"{stem}Test.java"
        if language == "go":
            return f"{stem}_test.go"
        if language == "ruby":
            return f"spec/{stem}_spec.rb"
        return f"tests/test_{stem}"

    # ── Utilities ────────────────────────────────────────────────────

    def _read_file(self, path: str) -> str:
        try:
            with open(path, encoding="utf-8") as f:
                return f.read()
        except Exception as exc:
            logger.warning("Could not read %s: %s", path, exc)
            return ""

    def _slugify(self, text: str) -> str:
        """Convert text to valid Python identifier."""
        if not text:
            return "unnamed"
        # Remove special characters and replace with underscores
        slug = re.sub(r"[\W_]", "_", text.lower())
        # Replace multiple underscores with single
        slug = re.sub(r"_+", "_", slug)
        # Remove leading/trailing underscores and spaces
        slug = slug.strip(" _")
        return slug or "unnamed"

    def _compute_test_file_path(
        self, source_path: str, framework_info: dict[str, str] | None = None
    ) -> str:
        """Generate test file path from source path."""
        if framework_info:
            language = framework_info.get("language", "python")
        else:
            # Try to detect from extension
            ext = Path(source_path).suffix.lower()
            language = self._project_analyzer.EXTENSION_TO_LANGUAGE.get(ext, "python")

        stem = Path(source_path).stem
        if language == "python":
            return f"tests/test_{stem}.py"
        if language in ("typescript",):
            return f"src/__tests__/{stem}.test.ts"
        if language in ("javascript",):
            return f"src/__tests__/{stem}.test.js"
        if language == "csharp":
            return f"{stem}Tests.cs"
        if language == "java":
            return f"{stem}Test.java"
        if language == "go":
            return f"{stem}_test.go"
        if language == "ruby":
            return f"spec/{stem}_spec.rb"
        return f"tests/test_{stem}"

    def _path_to_module(self, path: str) -> str:
        """Convert file path to module string."""
        # Remove extension and replace path separators with dots
        path_without_ext = str(Path(path).with_suffix(""))
        return path_without_ext.replace("/", ".").replace("\\", ".")

    def _parse_user_story(self, story: str) -> list[dict[str, Any]]:
        """Parse user story into structured scenarios."""
        scenarios = []
        lines = story.strip().split("\n")

        current_scenario = {"title": "", "steps": []}

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # Check if this is a title (first line or line without Given/When/Then/And/But)
            if not current_scenario["title"] and not any(
                line.startswith(prefix)
                for prefix in ["Given", "When", "Then", "And", "But", "-"]
            ):
                current_scenario["title"] = line
            elif line.startswith("-"):
                # Bullet point format
                if not current_scenario["title"]:
                    current_scenario["title"] = "Feature test"
                current_scenario["steps"].append(line[1:].strip())
            elif any(
                line.startswith(prefix)
                for prefix in ["Given", "When", "Then", "And", "But"]
            ):
                # Given/When/Then format
                if not current_scenario["title"]:
                    current_scenario["title"] = "Test scenario"
                current_scenario["steps"].append(line)

        if current_scenario["title"] or current_scenario["steps"]:
            scenarios.append(current_scenario)

        return scenarios
