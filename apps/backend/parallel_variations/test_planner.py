"""Tests for the parallel-variations scaffolding + comparison."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from parallel_variations import (
    PARALLEL_VARIATIONS_ENV_VAR,
    compare_variations,
    create_variations,
    list_variations,
    parallel_variations_limit,
)


def _seed_spec(spec_dir: Path) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "spec.md").write_text("# Spec body\n", encoding="utf-8")
    (spec_dir / "requirements.json").write_text("{}", encoding="utf-8")
    (spec_dir / "context.json").write_text("{}", encoding="utf-8")


# ---------------------------------------------------------------------------
# Limit parsing


class TestLimit:
    def test_default_is_one(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(PARALLEL_VARIATIONS_ENV_VAR, raising=False)
        assert parallel_variations_limit() == 1

    def test_clamps_to_hard_max(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "100")
        assert parallel_variations_limit() == 5

    def test_invalid_falls_back(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "many")
        assert parallel_variations_limit() == 1


# ---------------------------------------------------------------------------
# Scaffolding


class TestCreateVariations:
    def test_creates_n_subfolders_with_inherited_files(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "3")
        _seed_spec(tmp_path)
        manifest = create_variations(tmp_path, 3)
        assert len(manifest.variations) == 3
        for v in manifest.variations:
            assert v.path.is_dir()
            assert (v.path / "spec.md").exists()
            assert (v.path / "requirements.json").exists()
            assert (v.path / ".variation.json").exists()

    def test_seed_is_deterministic_per_slot(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "3")
        _seed_spec(tmp_path)
        m1 = create_variations(tmp_path, 3)
        # Re-running with same count returns same descriptors with same seeds.
        m2 = create_variations(tmp_path, 3)
        assert [v.seed for v in m1.variations] == [v.seed for v in m2.variations]

    def test_existing_variations_preserved(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "3")
        _seed_spec(tmp_path)
        create_variations(tmp_path, 2)
        # Drop a file inside v1 — re-running create should not delete it.
        marker = tmp_path / "variations" / "v1" / "user_marker.txt"
        marker.write_text("don't touch me", encoding="utf-8")
        create_variations(tmp_path, 3)
        assert marker.exists()
        assert (tmp_path / "variations" / "v3").is_dir()

    def test_count_above_cap_raises(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "2")
        _seed_spec(tmp_path)
        with pytest.raises(ValueError, match="exceeds"):
            create_variations(tmp_path, 5)

    def test_zero_count_raises(self, tmp_path: Path) -> None:
        _seed_spec(tmp_path)
        with pytest.raises(ValueError, match="≥ 1"):
            create_variations(tmp_path, 0)

    def test_missing_spec_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="does not exist"):
            create_variations(tmp_path / "ghost", 1)


# ---------------------------------------------------------------------------
# list_variations


class TestListVariations:
    def test_no_variations_dir_returns_empty(self, tmp_path: Path) -> None:
        _seed_spec(tmp_path)
        manifest = list_variations(tmp_path)
        assert manifest.variations == []

    def test_lists_existing_variations(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "3")
        _seed_spec(tmp_path)
        create_variations(tmp_path, 3)
        manifest = list_variations(tmp_path)
        assert [v.label for v in manifest.variations] == ["v1", "v2", "v3"]


# ---------------------------------------------------------------------------
# compare_variations


def _seed_variation_state(
    spec_dir: Path,
    label: str,
    *,
    completed: int,
    total: int,
    qa_status: str = "approved",
    qa_report_chars: int = 200,
    self_review: bool = False,
) -> None:
    v = spec_dir / "variations" / label
    plan = {
        "feature": "demo",
        "phases": [
            {
                "name": "p1",
                "subtasks": [
                    {"id": f"st-{i}", "status": "completed"} for i in range(completed)
                ]
                + [
                    {"id": f"st-{i}", "status": "pending"}
                    for i in range(completed, total)
                ],
            }
        ],
        "qa_signoff": {"status": qa_status},
    }
    (v / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")
    if qa_report_chars > 0:
        (v / "qa_report.md").write_text("x" * qa_report_chars, encoding="utf-8")
    if self_review:
        (v / "self_review.md").write_text("notes", encoding="utf-8")


class TestCompareVariations:
    def test_picks_only_approved_winner(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "3")
        _seed_spec(tmp_path)
        create_variations(tmp_path, 3)
        _seed_variation_state(
            tmp_path, "v1", completed=2, total=4, qa_status="rejected"
        )
        _seed_variation_state(
            tmp_path, "v2", completed=4, total=4, qa_status="approved"
        )
        _seed_variation_state(
            tmp_path, "v3", completed=4, total=4, qa_status="rejected"
        )
        comparison = compare_variations(tmp_path)
        assert comparison.suggested_winner == "v2"
        assert len(comparison.rows) == 3

    def test_no_winner_when_tied(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "2")
        _seed_spec(tmp_path)
        create_variations(tmp_path, 2)
        # Both fully completed, both approved, same report length → no clear winner.
        for label in ("v1", "v2"):
            _seed_variation_state(
                tmp_path, label, completed=2, total=2, qa_report_chars=100
            )
        comparison = compare_variations(tmp_path)
        assert comparison.suggested_winner is None

    def test_to_dict_round_trip(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(PARALLEL_VARIATIONS_ENV_VAR, "1")
        _seed_spec(tmp_path)
        create_variations(tmp_path, 1)
        _seed_variation_state(tmp_path, "v1", completed=1, total=1)
        encoded = json.dumps(compare_variations(tmp_path).to_dict())
        decoded = json.loads(encoded)
        assert decoded["spec_id"] == tmp_path.name
        assert decoded["rows"][0]["label"] == "v1"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
