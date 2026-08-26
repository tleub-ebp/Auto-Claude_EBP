"""The corpus itself has to stay trustworthy.

A replay is only as good as the episodes it runs on, and episodes rot in ways
that are quiet: a signal name gets typo'd and the episode silently becomes "the
baseline failed here", which turns a candidate that changed nothing into a
measured improvement. These tests are the corpus's own lint.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.replay import Episode, load_episodes  # noqa: E402
from learning_loop.skill_proposer import ExternalSignal  # noqa: E402

GOLDEN = Path(__file__).parent / "golden"

EPISODES: list[Episode] = load_episodes(GOLDEN)
FILES = sorted(GOLDEN.rglob("*.json"))


def test_the_corpus_is_not_empty():
    assert EPISODES, f"no episodes under {GOLDEN}"


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_every_file_parses(path: Path):
    """A malformed episode must fail here, not halfway through a promotion."""
    assert load_episodes(path.parent, agent_id="") is not None
    json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("episode", EPISODES, ids=lambda e: e.episode_id)
def test_every_episode_says_why_it_exists(episode: Episode):
    """A case nobody can explain is a case nobody will maintain."""
    why = episode.context.get("why_this_is_here", "")
    assert len(why) > 40, f"{episode.episode_id}: explain what this case discriminates"


@pytest.mark.parametrize("episode", EPISODES, ids=lambda e: e.episode_id)
def test_every_episode_names_something_observable(episode: Episode):
    """Grading has to be able to look at something outside the agent."""
    assert episode.context.get("observable"), (
        f"{episode.episode_id}: no observable — "
        f"nothing to grade against except the agent's own report"
    )


@pytest.mark.parametrize("episode", EPISODES, ids=lambda e: e.episode_id)
def test_baseline_signals_are_external_only(episode: Episode):
    for signal in episode.baseline_signals:
        assert isinstance(signal, ExternalSignal)


@pytest.mark.parametrize("episode", EPISODES, ids=lambda e: e.episode_id)
def test_the_file_lives_under_the_agent_it_belongs_to(episode: Episode):
    """Layout is `golden/<agent-id>/<case>.json`, and `load_episodes` filters
    by the field, so a misfiled case would be findable but unreadable."""
    assert episode.episode_id.startswith(f"{episode.agent_id}/"), (
        f"{episode.episode_id}: id should be '<agent-id>/<case>'"
    )


def test_episode_ids_are_unique():
    ids = [e.episode_id for e in EPISODES]
    assert len(ids) == len(set(ids)), "duplicate episode id — one will mask the other"


def test_the_corpus_contains_cases_the_baseline_failed():
    """A corpus where everything already passes can only detect regressions.

    Improvements would be unmeasurable, so a candidate that fixes a real
    problem would look identical to one that does nothing.
    """
    failing = [e for e in EPISODES if not e.baseline_passed]
    assert failing, "no failing episodes: improvements cannot be measured"


def test_the_corpus_covers_more_than_one_agent():
    agents = {e.agent_id for e in EPISODES}
    assert len(agents) > 1, f"only {agents} covered — per-agent scoping is untested"


def test_an_unknown_signal_name_is_rejected(tmp_path: Path):
    (tmp_path / "bad.json").write_text(
        json.dumps(
            {
                "episode_id": "x/bad",
                "agent_id": "x",
                "task": "t",
                "baseline_signals": ["agent_said_so"],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unknown external signal"):
        load_episodes(tmp_path)


def test_an_episode_missing_its_task_is_rejected(tmp_path: Path):
    (tmp_path / "bad.json").write_text(
        json.dumps({"episode_id": "x/bad", "agent_id": "x"}), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="missing task"):
        load_episodes(tmp_path)


def test_loading_a_missing_directory_is_empty_not_an_error(tmp_path: Path):
    """A repo with no corpus yet still runs; `ReplayResult.clean` is what
    refuses the promotion, and it says so for the right reason."""
    assert load_episodes(tmp_path / "nope") == []
