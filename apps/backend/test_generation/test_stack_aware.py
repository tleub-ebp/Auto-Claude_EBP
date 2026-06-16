"""Tests for stack-aware automatic test planning (stack_aware.py)."""

import json

from test_generation.stack_aware import (
    KIND_API,
    KIND_UNIT,
    KIND_WEB,
    KIND_WINFORMS,
    StackProfile,
    build_auto_test_instructions,
    classify_file,
    detect_stack,
)


def _write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestDetectStack:
    def test_detects_winforms_with_nunit_and_flaui(self, tmp_path):
        _write(
            tmp_path / "src" / "App" / "App.csproj",
            """<Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup>
              <ItemGroup>
                <PackageReference Include="NUnit" Version="3.14.0" />
                <PackageReference Include="FlaUI.UIA3" Version="4.0.0" />
              </ItemGroup>
            </Project>""",
        )
        profile = detect_stack(tmp_path)
        assert profile.dotnet
        assert profile.winforms
        assert profile.dotnet_test_framework == "NUnit"
        assert profile.winforms_ui_test_lib == "FlaUI"

    def test_detects_legacy_packages_config(self, tmp_path):
        _write(
            tmp_path / "App" / "packages.config",
            """<?xml version="1.0"?>
            <packages>
              <package id="xunit" version="2.4.1" />
            </packages>""",
        )
        _write(
            tmp_path / "App" / "App.csproj",
            '<Project><Reference Include="System.Windows.Forms" /></Project>',
        )
        profile = detect_stack(tmp_path)
        assert profile.dotnet
        assert profile.winforms
        assert profile.dotnet_test_framework == "xUnit"

    def test_detects_node_web_stack(self, tmp_path):
        _write(
            tmp_path / "package.json",
            json.dumps(
                {
                    "dependencies": {"react": "^18.0.0", "express": "^4.18.0"},
                    "devDependencies": {
                        "vitest": "^1.0.0",
                        "@playwright/test": "^1.40.0",
                    },
                }
            ),
        )
        profile = detect_stack(tmp_path)
        assert profile.node
        assert profile.web_framework == "React"
        assert profile.js_test_framework == "vitest"
        assert profile.e2e_framework == "Playwright"
        assert profile.node_api_framework == "Express"

    def test_detects_python_fastapi(self, tmp_path):
        _write(tmp_path / "requirements.txt", "fastapi==0.110.0\npytest==8.0.0\n")
        profile = detect_stack(tmp_path)
        assert profile.python
        assert profile.python_test_framework == "pytest"
        assert profile.python_api_framework == "FastAPI"

    def test_empty_project_yields_empty_profile(self, tmp_path):
        profile = detect_stack(tmp_path)
        assert not profile.dotnet
        assert not profile.node
        assert not profile.python


class TestClassifyFile:
    def test_winforms_form(self):
        profile = StackProfile(dotnet=True, winforms=True)
        assert classify_file("src/Views/MainForm.cs", profile) == KIND_WINFORMS
        assert classify_file("src/Views/frmClient.cs", profile) == KIND_WINFORMS

    def test_designer_files_are_skipped(self):
        profile = StackProfile(dotnet=True, winforms=True)
        assert classify_file("src/Views/MainForm.Designer.cs", profile) is None

    def test_aspnet_controller_is_api(self):
        profile = StackProfile(dotnet=True, aspnet=True)
        assert (
            classify_file("src/Controllers/InvoiceController.cs", profile) == KIND_API
        )

    def test_express_route_is_api(self):
        profile = StackProfile(node=True, node_api_framework="Express")
        assert classify_file("server/routes/users.ts", profile) == KIND_API

    def test_react_component_is_web(self):
        profile = StackProfile(node=True, web_framework="React")
        assert classify_file("src/components/UserCard.tsx", profile) == KIND_WEB

    def test_plain_module_is_unit(self):
        profile = StackProfile(node=True)
        assert classify_file("src/lib/pricing.ts", profile) == KIND_UNIT

    def test_non_code_and_test_files_skipped(self):
        profile = StackProfile(node=True)
        assert classify_file("README.md", profile) is None
        assert classify_file("src/lib/__tests__/pricing.test.ts", profile) is None
        assert classify_file("config/settings.json", profile) is None

    def test_windows_backslash_paths(self):
        profile = StackProfile(dotnet=True, aspnet=True)
        assert (
            classify_file("Src\\Api\\Controllers\\TvaController.cs", profile)
            == KIND_API
        )


class TestBuildAutoTestInstructions:
    def test_winforms_project_without_ui_lib_avoids_new_dependency(self, tmp_path):
        _write(
            tmp_path / "App.csproj",
            """<Project>
              <PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup>
              <ItemGroup><PackageReference Include="NUnit" Version="3.14.0" /></ItemGroup>
            </Project>""",
        )
        section = build_auto_test_instructions(
            tmp_path, ["Forms/MainForm.cs", "Services/TvaService.cs"]
        )
        assert section is not None
        assert "WinForms UI tests" in section
        assert "do NOT add one" in section
        assert "NUnit" in section
        assert "Unit tests" in section

    def test_groups_api_web_and_unit(self, tmp_path):
        _write(
            tmp_path / "package.json",
            json.dumps(
                {
                    "dependencies": {"react": "*", "express": "*"},
                    "devDependencies": {"vitest": "*", "cypress": "*"},
                }
            ),
        )
        section = build_auto_test_instructions(
            tmp_path,
            [
                "server/routes/orders.ts",
                "src/components/OrderList.tsx",
                "src/lib/totals.ts",
            ],
        )
        assert section is not None
        assert "API contract tests" in section
        assert "Cypress" in section
        assert "Unit tests" in section
        assert "NEVER add new test dependencies" in section

    def test_returns_none_when_nothing_testable(self, tmp_path):
        assert build_auto_test_instructions(tmp_path, ["docs/README.md"]) is None
        assert build_auto_test_instructions(tmp_path, []) is None
