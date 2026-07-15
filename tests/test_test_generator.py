"""Unit tests for TestGeneratorAgent (Feature 8.3).

Tests the test generator agent including:
- Code analysis and function extraction
- Coverage gap detection
- Unit test generation
- TDD mode test generation
- E2E test generation from user stories
- Test file building
- Utility functions
"""

import json
import textwrap
from unittest.mock import MagicMock, patch

import pytest

from apps.backend.agents.test_generator import (
    CodeAnalyzer,
    CoverageGap,
    FunctionInfo,
    GeneratedTest,
    TestGenerationResult,
    TestGeneratorAgent,
)


class _FakeOneshot:
    """Stand-in for ``core.oneshot.oneshot_completion``.

    Records the prompts it is handed and returns a fixed response, so the
    generation tests are deterministic and never touch a real provider. The
    signature mirrors the real function (including ``on_delta``) so it slots in
    via ``patch("core.oneshot.oneshot_completion", new=...)``.
    """

    def __init__(self, response: str) -> None:
        self.response = response
        self.prompts: list[str] = []

    async def __call__(
        self, prompt, system_prompt=None, project_dir=None, on_delta=None, **_kwargs
    ):
        self.prompts.append(prompt)
        if on_delta is not None:
            on_delta(self.response)
        return self.response


def _patch_llm(response: str) -> tuple:
    """Return ``(_FakeOneshot, patch_ctx)`` patching the shared LLM entrypoint."""
    fake = _FakeOneshot(response)
    return fake, patch("core.oneshot.oneshot_completion", new=fake)

# ── CodeAnalyzer tests ──────────────────────────────────────────


class TestCodeAnalyzer:
    """Tests for CodeAnalyzer source code analysis."""

    @pytest.fixture
    def analyzer(self):
        """Create a CodeAnalyzer instance."""
        return CodeAnalyzer()

    def test_analyze_simple_function(self, analyzer):
        """analyze_source() extracts a simple function."""
        source = textwrap.dedent('''
            def greet(name: str) -> str:
                """Say hello."""
                return f"Hello, {name}"
        ''')

        result = analyzer.analyze_source(source, module="test.py")

        assert len(result) == 1
        assert result[0].name == "greet"
        assert result[0].args == ["name"]
        assert result[0].return_type == "str"
        assert "Say hello" in result[0].docstring

    def test_analyze_class_methods(self, analyzer):
        """analyze_source() extracts class methods with class_name."""
        source = textwrap.dedent('''
            class Calculator:
                def add(self, a: int, b: int) -> int:
                    """Add two numbers."""
                    return a + b

                def subtract(self, a: int, b: int) -> int:
                    return a - b
        ''')

        result = analyzer.analyze_source(source, module="calc.py")

        assert len(result) == 2
        assert result[0].name == "add"
        assert result[0].class_name == "Calculator"
        assert result[0].args == ["a", "b"]
        assert result[1].name == "subtract"
        assert result[1].class_name == "Calculator"

    def test_analyze_async_function(self, analyzer):
        """analyze_source() detects async functions."""
        source = textwrap.dedent('''
            async def fetch_data(url: str) -> dict:
                """Fetch data from URL."""
                pass
        ''')

        result = analyzer.analyze_source(source, module="async.py")

        assert len(result) == 1
        assert result[0].is_async is True

    def test_analyze_decorated_function(self, analyzer):
        """analyze_source() extracts decorator information."""
        source = textwrap.dedent('''
            class MyClass:
                @property
                def value(self) -> int:
                    return 42

                @staticmethod
                def helper() -> str:
                    return "help"
        ''')

        result = analyzer.analyze_source(source, module="deco.py")

        assert len(result) == 2
        assert "property" in result[0].decorators
        assert "staticmethod" in result[1].decorators

    def test_analyze_complexity(self, analyzer):
        """analyze_source() estimates cyclomatic complexity."""
        source = textwrap.dedent('''
            def complex_func(x, y):
                if x > 0:
                    if y > 0:
                        return x + y
                    else:
                        return x - y
                elif x == 0:
                    return y
                else:
                    for i in range(y):
                        if i % 2 == 0:
                            continue
                    return -1
        ''')

        result = analyzer.analyze_source(source, module="complex.py")

        assert len(result) == 1
        assert result[0].complexity >= 4

    def test_analyze_empty_source(self, analyzer):
        """analyze_source() returns empty list for empty source."""
        result = analyzer.analyze_source("", module="empty.py")

        assert result == []

    def test_analyze_invalid_syntax(self, analyzer):
        """analyze_source() returns empty list for invalid Python."""
        result = analyzer.analyze_source("def broken(:", module="bad.py")

        assert result == []

    def test_analyze_no_args_function(self, analyzer):
        """analyze_source() handles function with no arguments."""
        source = textwrap.dedent('''
            def get_version():
                return "1.0.0"
        ''')

        result = analyzer.analyze_source(source, module="ver.py")

        assert len(result) == 1
        assert result[0].args == []

    def test_analyze_self_excluded_from_args(self, analyzer):
        """analyze_source() excludes self/cls from args."""
        source = textwrap.dedent('''
            class Foo:
                def method(self, x):
                    pass

                @classmethod
                def class_method(cls, y):
                    pass
        ''')

        result = analyzer.analyze_source(source, module="foo.py")

        assert result[0].args == ["x"]
        assert result[1].args == ["y"]


# ── FunctionInfo model tests ────────────────────────────────────


class TestFunctionInfo:
    """Tests for FunctionInfo dataclass."""

    def test_full_name_with_class(self):
        """full_name includes class name when present."""
        func = FunctionInfo(name="method", module="test.py", class_name="MyClass")
        assert func.full_name == "MyClass.method"

    def test_full_name_without_class(self):
        """full_name is just the function name when no class."""
        func = FunctionInfo(name="func", module="test.py")
        assert func.full_name == "func"

    def test_is_private(self):
        """is_private detects private functions."""
        assert FunctionInfo(name="_helper", module="t").is_private is True
        assert FunctionInfo(name="public", module="t").is_private is False
        assert FunctionInfo(name="__init__", module="t").is_private is False

    def test_is_dunder(self):
        """is_dunder detects dunder methods."""
        assert FunctionInfo(name="__init__", module="t").is_dunder is True
        assert FunctionInfo(name="__str__", module="t").is_dunder is True
        assert FunctionInfo(name="_private", module="t").is_dunder is False
        assert FunctionInfo(name="public", module="t").is_dunder is False


# ── TestGeneratorAgent tests ────────────────────────────────────


class TestTestGeneratorAgent:
    """Tests for TestGeneratorAgent operations.

    The agent wraps an LLM, so these mock the shared ``oneshot_completion``
    entrypoint and assert the agent's *own* responsibilities: it builds the right
    prompt and faithfully parses the model's JSON into a result. The LLM's
    judgement (which functions are gaps, how many tests to write) is not
    deterministic and is intentionally not asserted here.
    """

    @pytest.fixture
    def agent(self):
        """Create a TestGeneratorAgent instance."""
        return TestGeneratorAgent()

    @pytest.fixture
    def sample_source(self, tmp_path):
        """Create a sample source file for testing."""
        source = textwrap.dedent('''
            class UserService:
                def __init__(self, db):
                    self.db = db

                def get_user(self, user_id: int) -> dict:
                    """Get a user by ID."""
                    return self.db.find(user_id)

                def create_user(self, name: str, email: str) -> dict:
                    """Create a new user."""
                    if not name:
                        raise ValueError("Name required")
                    return self.db.insert({"name": name, "email": email})

                def _validate_email(self, email: str) -> bool:
                    """Validate email format."""
                    return "@" in email

            def helper_function(x: int) -> int:
                """A standalone helper."""
                return x * 2
        ''')

        file_path = tmp_path / "user_service.py"
        file_path.write_text(source)
        return str(file_path)

    def test_analyze_coverage_finds_gaps(self, agent, sample_source):
        """analyze_coverage() parses the model's gaps into CoverageGap objects."""
        response = json.dumps(
            {
                "functions_analyzed": 4,
                "gaps": [
                    {"name": "get_user", "class_name": "UserService", "line_number": 5, "priority": "high", "reason": "public read", "suggested_test_count": 2},
                    {"name": "create_user", "class_name": "UserService", "line_number": 9, "priority": "high", "reason": "validates + writes", "suggested_test_count": 3},
                ],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            gaps = agent.analyze_coverage(sample_source)

        assert len(gaps) == 2
        assert all(isinstance(g, CoverageGap) for g in gaps)
        func_names = [g.function.name for g in gaps]
        assert "get_user" in func_names
        assert "create_user" in func_names

    def test_analyze_coverage_forwards_existing_tests(
        self, agent, sample_source, tmp_path
    ):
        """analyze_coverage() feeds existing tests into the prompt so the model
        can exclude already-covered functions."""
        test_source = "def test_get_user_returns_expected():\n    pass\n"
        test_path = tmp_path / "test_user_service.py"
        test_path.write_text(test_source)

        response = json.dumps({"functions_analyzed": 4, "gaps": []})
        fake, ctx = _patch_llm(response)
        with ctx:
            agent.analyze_coverage(sample_source, str(test_path))

        assert fake.prompts, "the agent should have called the model"
        assert "test_get_user_returns_expected" in fake.prompts[0]

    def test_analyze_coverage_priority_ordering(self, agent, sample_source):
        """analyze_coverage() surfaces high-priority gaps first, whatever order
        the model emitted them in."""
        response = json.dumps(
            {
                "functions_analyzed": 3,
                "gaps": [
                    {"name": "helper_function", "priority": "low", "reason": "trivial"},
                    {"name": "create_user", "priority": "high", "reason": "business logic"},
                    {"name": "get_user", "priority": "medium", "reason": "reads db"},
                ],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            gaps = agent.analyze_coverage(sample_source)

        priority_order = {"high": 0, "medium": 1, "low": 2}
        values = [priority_order[g.priority] for g in gaps]
        assert values == sorted(values)
        assert gaps[0].function.name == "create_user"  # high priority floats up

    def test_analyze_coverage_prompt_skips_dunders(self, agent, sample_source):
        """The coverage prompt instructs the model to skip dunders except
        __init__."""
        fake, ctx = _patch_llm(json.dumps({"functions_analyzed": 0, "gaps": []}))
        with ctx:
            agent.analyze_coverage(sample_source)

        assert "__init__" in fake.prompts[0]
        assert "dunder" in fake.prompts[0].lower()

    def test_generate_unit_tests(self, agent, sample_source):
        """generate_unit_tests() parses the model response into a result."""
        response = json.dumps(
            {
                "test_file_content": (
                    "import pytest\n"
                    "from user_service import UserService\n\n\n"
                    "def test_get_user_returns_record():\n"
                    "    assert UserService(FakeDB()).get_user(1) == {'id': 1}\n"
                ),
                "test_file_path": "tests/test_user_service.py",
                "tests_generated": 2,
                "functions_analyzed": 3,
                "generated_tests": [
                    {"test_name": "test_get_user_returns_record", "description": "reads a record"},
                    {"test_name": "test_create_user_requires_name", "description": "raises on empty name"},
                ],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            result = agent.generate_unit_tests(sample_source)

        assert isinstance(result, TestGenerationResult)
        assert result.source_file == sample_source
        assert result.functions_analyzed == 3
        assert result.tests_generated == 2
        assert len(result.generated_tests) == 2
        assert result.test_file_content != ""
        assert result.test_file_path != ""

    def test_generate_unit_tests_content(self, agent, sample_source):
        """generate_unit_tests() surfaces the model's real test file content."""
        response = json.dumps(
            {
                "test_file_content": "import pytest\n\n\ndef test_thing():\n    assert True\n",
                "test_file_path": "tests/test_user_service.py",
                "tests_generated": 1,
                "functions_analyzed": 1,
                "generated_tests": [{"test_name": "test_thing", "description": "x"}],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            result = agent.generate_unit_tests(sample_source)

        assert "import pytest" in result.test_file_content
        assert "def test_" in result.test_file_content

    def test_generation_keeps_content_mentioning_limit_or_error(
        self, agent, sample_source
    ):
        """Regression: a valid response whose test code says "limit"/"error" must
        NOT be discarded as a rate-limit and replaced with a placeholder stub.

        This is the exact failure that showed the "// Tests would be generated
        here when API is available" box for a feature named "…limitation…".
        """
        content = (
            "import pytest\n\n\n"
            "def test_rejects_value_over_limit():\n"
            "    # limitation check — error handling path\n"
            "    with pytest.raises(ValueError):\n"
            "        validate(999)\n"
        )
        response = json.dumps(
            {
                "test_file_content": content,
                "test_file_path": "tests/test_user_service.py",
                "tests_generated": 1,
                "functions_analyzed": 1,
                "generated_tests": [
                    {"test_name": "test_rejects_value_over_limit", "description": "boundary + error"}
                ],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            result = agent.generate_unit_tests(sample_source)

        assert result.test_file_content == content
        assert "Tests would be generated here" not in result.test_file_content
        assert result.tests_generated == 1
        # The empty-card fix: each test carries its real source, not "".
        assert "test_rejects_value_over_limit" in result.generated_tests[0].test_code

    def test_generate_unit_tests_forwards_max_and_existing(
        self, agent, sample_source, tmp_path
    ):
        """The unit prompt carries max_tests_per_function and existing tests."""
        test_source = "def test_get_user_returns_expected():\n    pass\n"
        test_path = tmp_path / "test_existing.py"
        test_path.write_text(test_source)

        response = json.dumps(
            {
                "test_file_content": "import pytest\n\n\ndef test_x():\n    assert True\n",
                "test_file_path": "tests/test_user_service.py",
                "tests_generated": 1,
                "functions_analyzed": 1,
                "generated_tests": [{"test_name": "test_x", "description": "x"}],
            }
        )
        fake, ctx = _patch_llm(response)
        with ctx:
            agent.generate_unit_tests(
                sample_source, str(test_path), max_tests_per_function=1
            )

        assert "Max tests per function: 1" in fake.prompts[0]
        assert "test_get_user_returns_expected" in fake.prompts[0]

    def test_generate_tdd_tests(self, agent):
        """generate_tdd_tests() parses the failing-test file the model returns."""
        spec = {
            "name": "calculate_price",
            "module": "pricing",
            "description": "Calculate final price with discount and tax",
            "language": "python",
            "edge_cases": ["zero discount", "negative price"],
        }
        response = json.dumps(
            {
                "test_file_content": (
                    "import pytest\n"
                    "from pricing import calculate_price\n\n\n"
                    "def test_calculate_price_applies_discount():\n"
                    "    assert calculate_price(100, 0.1, 0.2) == pytest.approx(108.0)\n\n\n"
                    "def test_calculate_price_rejects_negative():\n"
                    "    with pytest.raises(ValueError):\n"
                    "        calculate_price(-1, 0, 0)\n"
                ),
                "test_file_path": "tests/test_calculate_price.py",
                "tests_generated": 2,
                "functions_analyzed": 0,
                "generated_tests": [
                    {"test_name": "test_calculate_price_applies_discount", "description": "happy path"},
                    {"test_name": "test_calculate_price_rejects_negative", "description": "error case"},
                ],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            result = agent.generate_tdd_tests(spec)

        assert isinstance(result, TestGenerationResult)
        assert result.tests_generated == 2
        assert "calculate_price" in result.test_file_content
        assert len(result.generated_tests) == 2
        assert result.generated_tests[0].test_code.strip()

    def test_generate_e2e_from_user_story(self, agent):
        """generate_tests_from_user_story() parses E2E tests and normalises path."""
        user_story = (
            "User registration flow\n"
            "Given a new user visits the registration page\n"
            "When they fill in their name and email\n"
            "Then they should see a success message"
        )
        response = json.dumps(
            {
                "test_file_content": (
                    "import pytest\n\n\n"
                    "def test_user_registration_flow():\n"
                    "    assert register('Ada', 'ada@x.io')['ok'] is True\n"
                ),
                "test_file_path": "e2e/test_auth.py",
                "tests_generated": 1,
                "functions_analyzed": 0,
                "generated_tests": [
                    {"test_name": "test_user_registration_flow", "description": "happy path"}
                ],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            result = agent.generate_tests_from_user_story(
                user_story, target_module="auth"
            )

        assert isinstance(result, TestGenerationResult)
        assert result.tests_generated >= 1
        assert "e2e" in result.test_file_path
        assert "registration" in result.test_file_content

    def test_e2e_path_normalised_when_model_omits_e2e(self, agent):
        """E2E results always land under an e2e/ path even if the model didn't."""
        response = json.dumps(
            {
                "test_file_content": "def test_flow():\n    assert True\n",
                "test_file_path": "tests/test_auth.py",  # missing e2e/
                "tests_generated": 1,
                "generated_tests": [{"test_name": "test_flow", "description": "x"}],
            }
        )
        _fake, ctx = _patch_llm(response)
        with ctx:
            result = agent.generate_tests_from_user_story("A story", target_module="auth")

        assert "e2e" in result.test_file_path

    def test_generation_falls_back_to_raw_response_when_not_json(
        self, agent, sample_source
    ):
        """When the model returns raw code (no JSON envelope), the user still
        sees it — not an empty box or a fake stub."""
        raw = "import pytest\n\n\ndef test_raw():\n    assert True\n"
        _fake, ctx = _patch_llm(raw)
        with ctx:
            result = agent.generate_unit_tests(sample_source)

        assert result.test_file_content == raw
        assert "Tests would be generated here" not in result.test_file_content


# ── Utility method tests ────────────────────────────────────────


class TestUtilities:
    """Tests for TestGeneratorAgent utility methods."""

    @pytest.fixture
    def agent(self):
        return TestGeneratorAgent()

    def test_slugify(self, agent):
        """_slugify() converts text to valid Python identifier."""
        assert agent._slugify("Hello World!") == "hello_world"
        assert agent._slugify("test-case-1") == "test_case_1"
        assert agent._slugify("CamelCase") == "camelcase"
        assert agent._slugify("") == "unnamed"
        assert agent._slugify("  spaces  ") == "spaces"

    def test_compute_test_file_path(self, agent):
        """_compute_test_file_path() generates correct test path."""
        assert "test_connector.py" in agent._compute_test_file_path(
            "src/connectors/jira/connector.py"
        )

    def test_path_to_module(self, agent):
        """_path_to_module() converts path to module string."""
        result = agent._path_to_module("src/connectors/jira/connector.py")
        assert result == "src.connectors.jira.connector"

    def test_parse_user_story_with_given_when_then(self, agent):
        """_parse_user_story() parses Given/When/Then format."""
        story = (
            "Login flow\n"
            "Given a registered user\n"
            "When they enter valid credentials\n"
            "Then they should be logged in"
        )

        scenarios = agent._parse_user_story(story)

        assert len(scenarios) == 1
        assert scenarios[0]["title"] == "Login flow"
        assert len(scenarios[0]["steps"]) == 3

    def test_parse_user_story_with_bullets(self, agent):
        """_parse_user_story() parses bullet-point format."""
        story = (
            "Feature test\n"
            "- Open the page\n"
            "- Click the button\n"
            "- Verify result"
        )

        scenarios = agent._parse_user_story(story)

        assert len(scenarios) == 1
        assert len(scenarios[0]["steps"]) == 3


# ── _extract_json robustness ────────────────────────────────────


class TestExtractJson:
    """The JSON extractor must trust valid JSON and only bail on unparseable text.

    Regression cover for the bug where any response containing the substrings
    "limit"/"error"/"reset" was thrown away as a rate-limit — which silently
    discarded real generated tests for a feature named "…limitation…".
    """

    @pytest.fixture
    def agent(self):
        return TestGeneratorAgent()

    def test_parses_valid_json_even_when_it_mentions_limit_and_error(self, agent):
        payload = {
            "test_file_content": "// limitation check; throws on error\n",
            "tests_generated": 1,
        }
        data = agent._extract_json(json.dumps(payload))
        assert data["tests_generated"] == 1
        assert "limitation" in data["test_file_content"]

    def test_parses_json_wrapped_in_markdown_fence(self, agent):
        raw = '```json\n{"tests_generated": 2, "note": "handles error paths"}\n```'
        data = agent._extract_json(raw)
        assert data["tests_generated"] == 2

    def test_parses_json_embedded_in_prose(self, agent):
        raw = 'Sure! Here is the object:\n{"tests_generated": 3}\nHope this helps.'
        data = agent._extract_json(raw)
        assert data["tests_generated"] == 3

    def test_returns_empty_dict_for_unparseable_text(self, agent):
        assert agent._extract_json("rate limit exceeded, try again later") == {}
        assert agent._extract_json("") == {}


# ── GeneratedTest model tests ───────────────────────────────────


class TestGeneratedTestModel:
    """Tests for GeneratedTest dataclass."""

    def test_generated_test_defaults(self):
        """GeneratedTest has sensible defaults."""
        test = GeneratedTest(
            test_name="test_foo",
            test_code="def test_foo(): pass",
            target_function="foo",
        )
        assert test.test_type == "unit"
        assert test.imports == []
        assert test.fixtures == []

    def test_test_generation_result_defaults(self):
        """TestGenerationResult has sensible defaults."""
        result = TestGenerationResult(source_file="test.py")
        assert result.functions_analyzed == 0
        assert result.tests_generated == 0
        assert result.coverage_gaps == []
        assert result.generated_tests == []
