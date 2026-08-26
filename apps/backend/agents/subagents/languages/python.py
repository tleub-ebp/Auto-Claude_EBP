"""Python overlay."""

from __future__ import annotations

from . import LanguageOverlay

OVERLAY = LanguageOverlay(
    language="python",
    test_commands=[
        "pytest -x -q                    # stop at the first failure",
        "pytest <path>::<TestClass>::<test>   # one test, when iterating",
        "pytest --timeout=120            # if the suite can hang",
    ],
    lint_commands=[
        "ruff check <paths>",
        "ruff format --check <paths>",
    ],
    notes=(
        "Read pytest.ini / pyproject.toml for testpaths and markers before "
        "guessing a path. A failing import in conftest.py shows up as a "
        "collection error, not a test failure — read the top of the output."
    ),
)
