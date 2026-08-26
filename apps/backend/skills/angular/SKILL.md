---
name: angular-development
description: Angular framework development, migration, and component generation. Use for Angular projects, version upgrades (15→19), component creation, and Angular-specific optimizations (standalone, signals, OnPush).
triggers: ["angular", "@angular", "ng", "angular upgrade", "angular migration"]
category: development
version: "1.0.0"
author: "WorkPilot AI Team"
---

# Angular Development

## Scripts (run via `skill.execute_script`)

- `scripts/analyze_angular_project.py` — detect Angular version, dependencies, project structure.
- `scripts/upgrade_angular_version.py` — version migrations with breaking-change detection + auto-fix.
- `scripts/generate_component.py` — scaffold components (standalone by default).
- Templates: `templates/component.ts.template`, `templates/standalone.component.ts.template`
  (suffixed `.template` because `{{ComponentName}}` placeholders are not valid TypeScript —
  a formatter run once rewrote them into uncompilable code).

```python
analysis = skill.execute_script("analyze_angular_project.py", {"project_root": "/path"})
skill.execute_script("upgrade_angular_version.py", {"project_root": "/path", "target_version": "19.0.0"})
skill.execute_script("generate_component.py", {"name": "UserProfile", "standalone": True, "project_root": "/path"})
```

## Version migrations

| Path | Key changes |
|------|-------------|
| 15→16 | Standalone components, signals introduits |
| 16→17 | Signals améliorés, nouveau control flow (`@if`/`@for`) |
| 17→18 | Apps zoneless, deferred loading |
| 18→19 | Hydration améliorée, gains de perf |

`upgrade_angular_version.py` détecte le code affecté par chaque breaking change, propose les correctifs et supporte le rollback. Migrer une version à la fois et tester entre chaque étape.

## Best practices

- **Components** : standalone par défaut, signals pour l'état réactif, `ChangeDetectionStrategy.OnPush`.
- **Performance** : `trackBy` dans les `@for`/`*ngFor`, lazy loading des routes/composants, tree-shaking.
- **Style** : suivre l'Angular style guide ; utiliser l'Angular CLI (`ng update`) pour les migrations.

## Skills liés

`framework-migration` (changements de stack complexes), `typescript`, `testing`.
