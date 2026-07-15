"""Tests for ``runners/flaky_tests_runner.py``.

Locks down the report discovery + parsing so the Flaky Test Detective
works on .NET (TRX) projects, not just JUnit ones. The MeCa project is a
C# solution and ``dotnet test`` emits TRX — a JUnit-only detective always
reported "0 tests" there.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from runners import flaky_tests_runner as ftr  # noqa: E402

JUNIT_XML = """<?xml version="1.0" encoding="utf-8"?>
<testsuite name="suite" tests="3">
  <testcase classname="pkg.Widget" name="test_ok" time="0.01"/>
  <testcase classname="pkg.Widget" name="test_flaky" time="0.02">
    <failure message="Timeout waiting for element">stack</failure>
  </testcase>
  <testcase classname="pkg.Widget" name="test_skipped" time="0">
    <skipped/>
  </testcase>
</testsuite>
"""

# TRX declares a default namespace — the parser must be namespace-agnostic.
TRX_XML = """<?xml version="1.0" encoding="UTF-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testName="Ns.WidgetTests.Ok" outcome="Passed"
                    duration="00:00:00.0120000"/>
    <UnitTestResult testName="Ns.WidgetTests.Flaky" outcome="Failed"
                    duration="00:00:01.5000000">
      <Output>
        <ErrorInfo>
          <Message>Connection refused by the socket</Message>
          <StackTrace>at Ns.WidgetTests.Flaky()</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult testName="Ns.WidgetTests.Ignored" outcome="NotExecuted"/>
  </Results>
</TestRun>
"""


def _parse(xml: str) -> list:
    root = ET.fromstring(xml)
    return ftr._parse_trx_root(root, "r", 0.0) if _is_trx(root) else ftr._parse_junit_root(
        root, "r", 0.0
    )


def _is_trx(root: ET.Element) -> bool:
    return ftr._local(root.tag).lower() == "testrun"


# --- JUnit ------------------------------------------------------------


def test_junit_parses_pass_fail_and_skips_skipped() -> None:
    runs = _parse(JUNIT_XML)
    assert len(runs) == 2  # skipped excluded
    by_name = {r.test_name: r for r in runs}
    assert by_name["pkg.Widget::test_ok"].passed is True
    flaky = by_name["pkg.Widget::test_flaky"]
    assert flaky.passed is False
    assert "Timeout" in flaky.error_message


# --- TRX --------------------------------------------------------------


def test_trx_parses_outcomes_namespace_agnostic() -> None:
    runs = _parse(TRX_XML)
    assert len(runs) == 2  # NotExecuted excluded
    by_name = {r.test_name: r for r in runs}
    assert by_name["Ns.WidgetTests.Ok"].passed is True
    failed = by_name["Ns.WidgetTests.Flaky"]
    assert failed.passed is False
    assert "Connection refused" in failed.error_message


def test_trx_duration_timespan_to_ms() -> None:
    result = ET.fromstring(
        '<UnitTestResult xmlns="x" testName="t" outcome="Passed" '
        'duration="00:00:01.5000000"/>'
    )
    assert ftr._trx_duration(result) == 1500.0


def test_dispatch_reads_root_tag_not_extension(tmp_path: Path) -> None:
    # A TRX payload saved with a .xml name must still be parsed as TRX.
    trx_as_xml = tmp_path / "results.xml"
    trx_as_xml.write_text(TRX_XML, encoding="utf-8")
    runs = ftr._parse_report_file(trx_as_xml, "r")
    assert {r.test_name for r in runs} == {
        "Ns.WidgetTests.Ok",
        "Ns.WidgetTests.Flaky",
    }


# --- discovery + end to end ------------------------------------------


def test_discover_finds_trx_files(tmp_path: Path) -> None:
    results = tmp_path / "TestResults"
    results.mkdir()
    (results / "run.trx").write_text(TRX_XML, encoding="utf-8")
    (tmp_path / "obj").mkdir()
    (tmp_path / "obj" / "ignored.trx").write_text(TRX_XML, encoding="utf-8")

    found = ftr._discover_reports(tmp_path)
    names = {p.name for p in found}
    assert "run.trx" in names
    assert "ignored.trx" not in names  # obj/ is ignored


def test_run_scan_flags_flaky_across_trx_reports(tmp_path: Path) -> None:
    # Same test passes in one run, fails in another -> flaky.
    passing = """<TestRun xmlns="x"><Results>
      <UnitTestResult testName="Ns.T.Flaky" outcome="Passed" duration="00:00:00.0"/>
    </Results></TestRun>"""
    failing = """<TestRun xmlns="x"><Results>
      <UnitTestResult testName="Ns.T.Flaky" outcome="Failed" duration="00:00:00.0">
        <Output><ErrorInfo><Message>timeout</Message></ErrorInfo></Output>
      </UnitTestResult>
    </Results></TestRun>"""
    for i, payload in enumerate([passing, failing, passing, failing]):
        (tmp_path / f"run{i}.trx").write_text(payload, encoding="utf-8")

    result = ftr.run_scan(tmp_path, threshold=0.05, min_runs=2)
    assert result["flakyCount"] == 1
    assert result["flakyTests"][0]["testName"] == "Ns.T.Flaky"


def test_empty_message_is_dotnet_aware(tmp_path: Path) -> None:
    (tmp_path / "App.csproj").write_text("<Project/>", encoding="utf-8")
    result = ftr.run_scan(tmp_path, threshold=0.05, min_runs=2)
    assert result["flakyCount"] == 0
    assert "C# / .NET" in result["summary"]
    assert "dotnet test --logger trx" in result["summary"]


def test_detect_languages_is_dynamic_and_multi(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    (tmp_path / "go.mod").write_text("module x", encoding="utf-8")
    labels = {label for label, _ in ftr._detect_languages(tmp_path)}
    assert "JavaScript / TypeScript" in labels
    assert "Go" in labels
    assert "C# / .NET" not in labels


def test_detect_python_by_extension(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("print()", encoding="utf-8")
    labels = {label for label, _ in ftr._detect_languages(tmp_path)}
    assert "Python" in labels


def test_detection_ignores_vendored_dirs(tmp_path: Path) -> None:
    vendored = tmp_path / "node_modules" / "dep"
    vendored.mkdir(parents=True)
    (vendored / "package.json").write_text("{}", encoding="utf-8")
    # Only a vendored package.json exists -> JS must NOT be detected.
    labels = {label for label, _ in ftr._detect_languages(tmp_path)}
    assert "JavaScript / TypeScript" not in labels


def test_empty_message_generic_without_known_stack(tmp_path: Path) -> None:
    (tmp_path / "README").write_text("hello", encoding="utf-8")
    result = ftr.run_scan(tmp_path, threshold=0.05, min_runs=2)
    assert "No test reports found" in result["summary"]
    assert "Detected stack" not in result["summary"]
