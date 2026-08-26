# Executable Python skills

Two skills live here — `angular/` and `migration/` — loaded by `skill_manager.py`.

**These are not the agent-facing skills.** Those live in `/skills/` and are served to
harnesses as markdown. The difference is the consumer: a skill here bundles Python
scripts that WorkPilot's own code executes, so it is a library with a manifest, not a
prompt. See [`/skills/README.md`](../../../skills/README.md) for the agent-facing side.

## Layout

```
<skill>/
  SKILL.md      frontmatter (name, description, triggers, category, version) + instructions
  scripts/      standalone executables invoked via skill.execute_script()
  data/         reference data (e.g. migration/data/breaking_changes.json)
  templates/    document templates
```

## Progressive loading

`SkillManager` loads in three steps so an unused skill costs almost nothing:

1. **Metadata** — every `SKILL.md` frontmatter, at construction.
2. **Instructions** — the body, on `load_skill(name)`.
3. **Resources** — scripts and templates, only when asked for.

```python
from skills.skill_manager import SkillManager

manager = SkillManager("apps/backend/skills")
skill = manager.load_skill("framework-migration")
result = skill.execute_script("analyze_stack.py", {"project-root": "/path/to/project"})
```

Frontmatter is parsed by `skills_registry.frontmatter`, the same parser every other
reader in the repo uses. Do not add another one.

## Code style

- Type hints on every signature; `ruff` 0.15.7 (`ruff check`, `ruff format --check`).
- Scripts must be runnable standalone and return structured success/failure.
- Keep `description` under ~512 characters and `triggers` to a handful — the metadata
  layer is always loaded, so it is the part that costs context on every run.

## Adding one

1. `mkdir <name>/{scripts,data,templates}`
2. Write `SKILL.md` with `name`, `description`, `triggers`, `category`, `version`.
3. Add scripts. Each takes `--flag value` arguments and prints JSON.
4. Test through `SkillManager`, not by importing the script directly — that is how it
   will actually be called.
