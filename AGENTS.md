# AGENTS.md — cartographie du dépôt WorkPilot AI

Point d'entrée pour tout agent de code (Copilot, Codex, Cursor, Amp, Gemini, Claude Code…).
Ce fichier est un **index de navigation**, pas un manuel : il dit où regarder, pas quoi penser.

> **Règles normatives** : [`docs/CLAUDE.md`](docs/CLAUDE.md). En cas de contradiction, `docs/CLAUDE.md` fait foi.
> **Configuration** : [`shared_docs/CONFIGURATION.md`](shared_docs/CONFIGURATION.md) · **Contribution** : [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md)

## Ce qu'est le produit

Application de bureau (+ CLI) où l'utilisateur décrit un objectif et où une chaîne d'agents
planifie, implémente et valide. Chaque tâche s'exécute dans un worktree git isolé.

Pipeline : **spec → planner → coder → QA reviewer → QA fixer → revue humaine → merge**.

## Règles critiques

| Règle | Pourquoi |
|---|---|
| **Claude Agent SDK uniquement** — jamais `anthropic.Anthropic()` en direct ; toujours `create_client()` de `core.client` | un seul point de configuration modèle/outils/sous-agents |
| **i18n obligatoire** — tout texte visible passe par une clé `react-i18next` | l'app est livrée en FR et EN |
| **Abstraction plateforme** — jamais `process.platform` en direct | Windows / macOS / Linux sont tous supportés en CI |
| **PR vers `develop`**, jamais `main` | `main` est la branche de release |
| **Versions d'outils épinglées** — ruff `0.15.7`, Biome `2.4.10` | toute autre version produit un diff que la CI refuse |

## Carte du dépôt

```
apps/backend/          Python. Agents, pipeline, API FastAPI (port 9000).
  agents/              planner, coder, QA + définitions de sous-agents SDK
  core/client.py       LA fabrique de clients LLM — tout passe par là
  cli/build_commands.py enchaînement des phases d'un build
  phase_config.py      modèle + budget de réflexion par phase et par provider
  model_router/        classification de tâche → tier qualité → modèle
  learning_loop/       patterns depuis les builds, phase observe, replay A/B des promotions
  mem_search/          lecture de la mémoire par paliers (skill mem-search)
  slash_commands/      sert .agents/skills/ à la barre de commandes du Kanban
  skills_registry/     parseur de frontmatter partagé (source unique)
  prompts/             les prompts système réels des agents
apps/frontend/         Electron + React + TypeScript + Zustand + Vite
src/                   Python partagé : connecteurs (Jira, Azure DevOps, grepai…), mémoire
tests/                 pytest (~200 fichiers). Les tests frontend vivent près du code.
scripts/               build, release, hooks, merge, wiki
docs/ shared_docs/     documentation
```

## Skills, agents et workflows

| Chemin | Rôle |
|---|---|
| `.agents/skills/<nom>/SKILL.md` | **source lue en production** par la barre de commandes du Kanban, quel que soit le LLM |
| `.claude/skills/`, `.github/skills/`, `.cursor/skills/` | miroirs par harness |
| `.gemini/commands/*.toml` | miroir Gemini CLI |
| `apps/backend/agents/subagents/` | **la** source des sous-agents : défauts de phase, overlays langage, spécialistes de PR |
| `.agents/agents/`, `.github/agents/`, `.codex/agents/` | sorties générées depuis ce registre, noms d'outils traduits par harness |

Le frontmatter d'un skill se lit **toujours** via `skills_registry.frontmatter.parse_frontmatter`.
Les champs propres à WorkPilot vivent sous `metadata.workpilot` (pack, version, targets,
requires, min_effort, provenance) — un espace que la spec Agent Skills laisse libre et que
Claude Code ignore.

## Commandes

```bash
pnpm run dev            # backend + frontend
pnpm test               # vitest (frontend)
pytest tests/ -v        # backend
pnpm run test:all       # suite complète de pré-push
pnpm run lint           # biome
```

Échappatoires de hooks : `PRE_COMMIT_SKIP_TESTS=1`, `PRE_PUSH_SKIP=1`, `PRE_PUSH_FULL=1`.

## Discipline de contexte

Plusieurs fichiers dépassent 3 000 lignes. **Ne pas les ouvrir en entier** : cibler avec
`grep` puis lire les lignes utiles.

| Fichier | Lignes | Index local |
|---|---|---|
| `apps/frontend/src/main/ipc-handlers/task/worktree-handlers.ts` | ~5 700 | — |
| `apps/frontend/src/main/claude-profile/usage-monitor.ts` | ~4 500 | — |
| `apps/frontend/src/renderer/components/KanbanBoard.tsx` | ~4 200 | [`kanban/AGENTS.md`](apps/frontend/src/renderer/components/kanban/AGENTS.md) |
| `apps/backend/core/client.py` | ~2 200 | — |
| `apps/backend/agents/coder.py` | ~2 200 | — |

Index par domaine : [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) · [`apps/frontend/AGENTS.md`](apps/frontend/AGENTS.md)

`grepai` fournit une recherche sémantique et retombe sur `grep` quand il est absent.
