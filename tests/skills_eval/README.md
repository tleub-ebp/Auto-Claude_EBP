# `tests/skills_eval/` — the gate the learning loop has to pass

The learning loop proposes changes to skill and subagent definitions. Without a
way to measure a proposal, it is a diff generator: every candidate looks
plausible, because the thing that judged it is the thing that wrote it.

This directory is the measurement. It holds a corpus of **golden episodes** —
real tasks, archived with the ground truth of how they turned out — and the
pytest suite that replays a candidate instruction over them.

## What is in here

```
golden/<agent-id>/<case>.json    one archived episode, one file
test_replay_gate.py              the A/B mechanics and their invariants
test_golden_corpus.py            the corpus itself must stay well-formed
```

An episode is one JSON file so that adding one is never a merge conflict:

```json
{
  "episode_id": "test-runner/python-collection-error",
  "agent_id": "test-runner",
  "language": "python",
  "task": "The suite reports 0 tests and a non-zero exit...",
  "baseline_signals": ["tests_passed"],
  "context": { "why_this_is_here": "...", "observable": "..." }
}
```

`baseline_signals` is **what the external verifiers said**, not a score and not
an opinion. An empty list means the baseline failed that episode — those are
the valuable ones, because they are how an improvement gets measured instead of
assumed. Every episode carries a `context.why_this_is_here`: a case nobody can
explain is a case nobody will maintain.

## Running it

```bash
pytest tests/skills_eval/ -v
```

No network, no API key, no cost. The suite uses a table-backed grader, so what
it exercises is the comparison arithmetic — which is where a bug would silently
approve a regression. Production passes a grader that re-runs the agent and the
real verifiers; the logic on both sides is the same `replay_ab`.

## The rule the suite enforces

A candidate is rejected if it breaks **one** episode the baseline got right,
however many others it fixes. The asymmetry is deliberate: a regression is
something that used to work and now does not, which is what users experience as
the tool breaking. Three improvements do not cancel it, and the candidate is
welcome back once it stops breaking the fourth.

An empty replay is not a pass. A new agent has no golden cases, and that is
exactly when an unmeasured promotion does the most damage.

## Adding an episode

Archive a task the product actually ran, with what the verifiers reported. Two
things make a case worth keeping: the outcome came from outside the agent
(tests, QA, `impeccable detect`, a merged PR that was not reverted), and the
episode discriminates — if every plausible instruction passes it, it measures
nothing.
