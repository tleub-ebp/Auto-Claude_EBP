"""Tests for the multi-repo orchestration package.

Covers the deterministic, non-LLM pieces of the cross-repo feature
(README §"Multi-Repo Orchestration"): the dependency graph, the spec
manager, and the breaking-change detector. The async LLM-driven
``MultiRepoOrchestrator`` is exercised separately by integration tests.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from orchestration import (
    BreakingChange,
    BreakingChangeDetector,
    CrossRepoSpecManager,
    DependencyType,
    MultiRepoManifest,
    RepoDependency,
    RepoDependencyGraph,
    RepoSubSpec,
)

# ---------------------------------------------------------------------------
# RepoDependencyGraph


class TestDependencyGraph:
    def test_topological_sort_simple_chain(self) -> None:
        # types -> backend -> frontend (frontend depends on backend depends on types)
        g = RepoDependencyGraph()
        g.add_dependency(
            RepoDependency("backend", "types", DependencyType.SHARED_TYPES)
        )
        g.add_dependency(RepoDependency("frontend", "backend", DependencyType.API))
        order = g.topological_sort()
        # Providers must appear before their consumers.
        assert order.index("types") < order.index("backend") < order.index("frontend")

    def test_topological_sort_isolated_nodes(self) -> None:
        g = RepoDependencyGraph()
        g.add_repo("alone-1")
        g.add_repo("alone-2")
        order = g.topological_sort()
        assert sorted(order) == ["alone-1", "alone-2"]

    def test_cycle_detection_raises(self) -> None:
        g = RepoDependencyGraph()
        g.add_dependency(RepoDependency("a", "b", DependencyType.PACKAGE))
        g.add_dependency(RepoDependency("b", "c", DependencyType.PACKAGE))
        g.add_dependency(RepoDependency("c", "a", DependencyType.PACKAGE))
        with pytest.raises(ValueError, match="Circular dependency"):
            g.topological_sort()

    def test_get_upstream_and_downstream(self) -> None:
        g = RepoDependencyGraph()
        g.add_dependency(RepoDependency("frontend", "backend", DependencyType.API))
        g.add_dependency(RepoDependency("mobile", "backend", DependencyType.API))
        # backend is upstream of both frontend and mobile
        downstream = g.get_downstream_repos("backend")
        assert sorted(downstream) == ["frontend", "mobile"]
        # frontend depends only on backend
        assert g.get_upstream_repos("frontend") == ["backend"]
        # backend has no upstream
        assert g.get_upstream_repos("backend") == []

    def test_round_trip_to_dict(self) -> None:
        g = RepoDependencyGraph()
        g.add_dependency(
            RepoDependency("a", "b", DependencyType.PACKAGE, details="lodash")
        )
        rebuilt = RepoDependencyGraph.from_dict(g.to_dict())
        assert rebuilt.repos == g.repos
        assert len(rebuilt.dependencies) == 1
        assert rebuilt.dependencies[0].details == "lodash"
        assert rebuilt.dependencies[0].dependency_type is DependencyType.PACKAGE

    def test_save_and_load(self, tmp_path: Path) -> None:
        g = RepoDependencyGraph()
        g.add_dependency(RepoDependency("a", "b", DependencyType.API))
        path = tmp_path / "graph.json"
        g.save(path)
        loaded = RepoDependencyGraph.load(path)
        assert loaded.repos == g.repos
        assert loaded.dependencies[0].source_repo == "a"

    def test_from_analysis_detects_package_dep(self) -> None:
        analyses = {
            "shared-lib": {
                "published_packages": ["@workpilot/shared"],
                "dependencies": [],
                "services": [],
            },
            "frontend": {
                "published_packages": [],
                "dependencies": ["@workpilot/shared", "react"],
                "services": [],
            },
        }
        g = RepoDependencyGraph.from_analysis(analyses)
        # frontend → shared-lib edge should exist.
        assert any(
            d.source_repo == "frontend"
            and d.target_repo == "shared-lib"
            and d.dependency_type is DependencyType.PACKAGE
            for d in g.dependencies
        )

    def test_from_analysis_detects_api_dep(self) -> None:
        analyses = {
            "auth-svc": {
                "published_packages": [],
                "dependencies": [],
                "services": [{"provides": ["/auth/login"], "consumes": []}],
            },
            "web": {
                "published_packages": [],
                "dependencies": [],
                "services": [{"provides": [], "consumes": ["/auth/login"]}],
            },
        }
        g = RepoDependencyGraph.from_analysis(analyses)
        assert any(
            d.source_repo == "web"
            and d.target_repo == "auth-svc"
            and d.dependency_type is DependencyType.API
            for d in g.dependencies
        )


# ---------------------------------------------------------------------------
# CrossRepoSpecManager + MultiRepoManifest


class TestCrossRepoSpecManager:
    def test_create_master_spec_writes_files(self, tmp_path: Path) -> None:
        mgr = CrossRepoSpecManager(tmp_path / "001-task")
        manifest = mgr.create_master_spec(
            task_description="Add auth across services",
            repos=[
                {"repo": "owner/frontend", "repo_path": "/x/frontend"},
                {"repo": "owner/backend", "repo_path": "/x/backend"},
            ],
            dependency_graph={"foo": "bar"},
            execution_order=["owner/backend", "owner/frontend"],
        )
        assert (tmp_path / "001-task" / "spec.md").exists()
        assert (tmp_path / "001-task" / "multi_repo_manifest.json").exists()
        # Sub-spec dirs created with sanitised names (slashes → underscores).
        assert (tmp_path / "001-task" / "repos" / "owner_frontend").is_dir()
        assert (tmp_path / "001-task" / "repos" / "owner_backend").is_dir()
        assert manifest.task_description == "Add auth across services"
        assert len(manifest.repos) == 2

    def test_master_spec_md_contains_execution_order(self, tmp_path: Path) -> None:
        mgr = CrossRepoSpecManager(tmp_path / "spec-2")
        mgr.create_master_spec(
            task_description="t",
            repos=[{"repo": "r1", "repo_path": "/r1"}],
            dependency_graph={},
            execution_order=["r1"],
        )
        spec_md = (tmp_path / "spec-2" / "spec.md").read_text(encoding="utf-8")
        assert "Execution Order" in spec_md
        assert "1. r1" in spec_md

    def test_save_and_load_manifest_round_trip(self, tmp_path: Path) -> None:
        mgr = CrossRepoSpecManager(tmp_path / "s3")
        original = mgr.create_master_spec(
            task_description="round-trip",
            repos=[{"repo": "owner/x", "repo_path": "/x"}],
            dependency_graph={},
            execution_order=["owner/x"],
        )
        original.update_sub_spec_status("owner/x", "completed", progress=100.0)
        mgr.save_manifest(original)

        loaded = mgr.load_manifest()
        assert loaded is not None
        assert loaded.task_description == "round-trip"
        assert loaded.repos[0].status == "completed"
        assert loaded.repos[0].progress == 100.0

    def test_load_manifest_missing_returns_none(self, tmp_path: Path) -> None:
        mgr = CrossRepoSpecManager(tmp_path / "ghost")
        assert mgr.load_manifest() is None

    def test_create_sub_spec_writes_implementation_plan_and_context(
        self, tmp_path: Path
    ) -> None:
        mgr = CrossRepoSpecManager(tmp_path / "s4")
        mgr.create_master_spec(
            task_description="t",
            repos=[{"repo": "owner/r", "repo_path": "/r"}],
            dependency_graph={},
            execution_order=["owner/r"],
        )
        sub_dir = mgr.create_sub_spec(
            "owner/r",
            spec_content="# sub spec",
            implementation_plan={"steps": [{"id": "s1"}]},
            context={"upstream": ["x"]},
        )
        assert (sub_dir / "spec.md").read_text(encoding="utf-8") == "# sub spec"
        plan = json.loads((sub_dir / "implementation_plan.json").read_text("utf-8"))
        ctx = json.loads((sub_dir / "context.json").read_text("utf-8"))
        assert plan == {"steps": [{"id": "s1"}]}
        assert ctx == {"upstream": ["x"]}


class TestManifestHelpers:
    def test_overall_progress_averages_repos(self) -> None:
        m = MultiRepoManifest(task_description="t")
        m.repos.append(RepoSubSpec(repo="a", repo_path="/a", progress=50.0))
        m.repos.append(RepoSubSpec(repo="b", repo_path="/b", progress=100.0))
        assert m.get_overall_progress() == 75.0

    def test_overall_progress_zero_when_no_repos(self) -> None:
        m = MultiRepoManifest(task_description="t")
        assert m.get_overall_progress() == 0.0

    def test_get_completed_repos(self) -> None:
        m = MultiRepoManifest(task_description="t")
        m.repos.extend(
            [
                RepoSubSpec(repo="a", repo_path="/a", status="completed"),
                RepoSubSpec(repo="b", repo_path="/b", status="failed"),
                RepoSubSpec(repo="c", repo_path="/c", status="completed"),
            ]
        )
        assert sorted(m.get_completed_repos()) == ["a", "c"]

    def test_update_sub_spec_status_ignores_unknown_field(self) -> None:
        m = MultiRepoManifest(task_description="t")
        m.repos.append(RepoSubSpec(repo="a", repo_path="/a"))
        m.update_sub_spec_status("a", "coding", does_not_exist="x", progress=42.0)
        sub = m.get_sub_spec("a")
        assert sub is not None
        assert sub.status == "coding"
        assert sub.progress == 42.0
        # Unknown field silently dropped (not added as attribute).
        assert not hasattr(sub, "does_not_exist")

    def test_round_trip_manifest_via_dict(self) -> None:
        m = MultiRepoManifest(task_description="t")
        m.repos.append(RepoSubSpec(repo="a", repo_path="/a", status="planning"))
        m.dependency_graph = {"x": [1, 2]}
        m.execution_order = ["a"]
        rebuilt = MultiRepoManifest.from_dict(m.to_dict())
        assert rebuilt.task_description == "t"
        assert rebuilt.repos[0].status == "planning"
        assert rebuilt.execution_order == ["a"]
        assert rebuilt.dependency_graph == {"x": [1, 2]}


# ---------------------------------------------------------------------------
# BreakingChangeDetector
#
# Uses real git repos in tmp dirs so we exercise the subprocess paths
# without needing to mock them (deterministic + fast).


def _git(repo: Path, *args: str) -> None:
    """Run a git command inside repo; raise on failure."""
    subprocess.run(
        ["git", *args],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo_with_file(repo: Path, file_name: str, content: str) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "test")
    (repo / file_name).write_text(content, encoding="utf-8")
    _git(repo, "add", file_name)
    _git(repo, "commit", "-q", "-m", "initial")


class TestBreakingChangeDataclass:
    def test_round_trip_to_dict(self) -> None:
        bc = BreakingChange(
            source_repo="prov",
            target_repo="cons",
            change_type="export",
            description="x",
            severity="warning",
            file_path="index.ts",
            suggestion="check",
        )
        rebuilt = BreakingChange.from_dict(bc.to_dict())
        assert rebuilt == bc


class TestBreakingChangeDetector:
    def test_no_changed_files_returns_empty(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        _init_repo_with_file(repo, "index.ts", "export const x = 1;\n")
        detector = BreakingChangeDetector({"r": repo})
        graph = RepoDependencyGraph()
        graph.add_dependency(RepoDependency("c", "r", DependencyType.PACKAGE))
        breaks = asyncio.run(detector.detect_breaking_changes(["r"], graph))
        assert breaks == []

    def test_detects_removed_export_in_index(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        _init_repo_with_file(
            repo,
            "index.ts",
            "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
        )
        # Modify (uncommitted) — remove 'b' export.
        (repo / "index.ts").write_text(
            "export const a = 1;\nexport const c = 3;\n", encoding="utf-8"
        )
        detector = BreakingChangeDetector({"shared": repo, "consumer": repo})
        graph = RepoDependencyGraph()
        graph.add_dependency(
            RepoDependency("consumer", "shared", DependencyType.PACKAGE)
        )
        breaks = asyncio.run(
            detector.detect_breaking_changes(["shared", "consumer"], graph)
        )
        assert any(
            bc.change_type == "export" and bc.target_repo == "consumer" for bc in breaks
        )

    def test_detects_api_endpoint_change(self, tmp_path: Path) -> None:
        repo = tmp_path / "api-repo"
        _init_repo_with_file(
            repo,
            "routes.py",
            '@app.get("/users")\ndef get_users(): pass\n@app.post("/users")\ndef create(): pass\n',
        )
        # Remove the post endpoint.
        (repo / "routes.py").write_text(
            '@app.get("/users")\ndef get_users(): pass\n', encoding="utf-8"
        )
        detector = BreakingChangeDetector({"api": repo, "web": repo})
        graph = RepoDependencyGraph()
        graph.add_dependency(RepoDependency("web", "api", DependencyType.API))
        breaks = asyncio.run(detector.detect_breaking_changes(["api", "web"], graph))
        assert any(
            bc.change_type == "api_contract" and bc.severity == "error" for bc in breaks
        )

    def test_detects_type_definition_removal(self, tmp_path: Path) -> None:
        repo = tmp_path / "types-repo"
        _init_repo_with_file(
            repo,
            "models.ts",
            "interface User {}\ninterface Admin {}\n",
        )
        (repo / "models.ts").write_text("interface User {}\n", encoding="utf-8")
        detector = BreakingChangeDetector({"types": repo, "consumer": repo})
        graph = RepoDependencyGraph()
        graph.add_dependency(
            RepoDependency("consumer", "types", DependencyType.SHARED_TYPES)
        )
        breaks = asyncio.run(
            detector.detect_breaking_changes(["types", "consumer"], graph)
        )
        assert any(bc.change_type == "type_definition" for bc in breaks)

    def test_summary_renders_human_readable_markdown(self) -> None:
        detector = BreakingChangeDetector({})
        breaks = [
            BreakingChange(
                source_repo="a",
                target_repo="b",
                change_type="api_contract",
                description="route gone",
                severity="error",
                suggestion="update b",
            ),
            BreakingChange(
                source_repo="c",
                target_repo="d",
                change_type="export",
                description="symbol gone",
                severity="warning",
            ),
        ]
        summary = detector.build_detection_summary(breaks)
        assert "Breaking Changes Detected: 2 total" in summary
        assert "Errors (1)" in summary
        assert "Warnings (1)" in summary
        assert "update b" in summary

    def test_summary_when_no_breaks(self) -> None:
        detector = BreakingChangeDetector({})
        assert detector.build_detection_summary([]) == "No breaking changes detected."


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
