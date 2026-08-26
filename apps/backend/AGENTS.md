# AGENTS.md — index du backend

Python 3.13+, FastAPI sur le port **9000**, WebSocket sur **8765**.
~100 packages de premier niveau. Ce fichier donne les points d'entrée qui comptent.

> Règles normatives : [`../../docs/CLAUDE.md`](../../docs/CLAUDE.md) · Racine : [`../../AGENTS.md`](../../AGENTS.md)

## Le chemin critique

Toute interaction LLM passe par ces fichiers. Les modifier touche l'ensemble du produit.

| Fichier | Lignes | Rôle |
|---|---|---|
| `core/client.py` | ~2 000 | **la fabrique**. `create_client()` (SDK Claude) et `create_agent_client()` (multi-provider). Résout modèle, outils, serveurs MCP, sous-agents. |
| `core/agent_client.py` | ~4 500 | les clients par provider : Copilot, Windsurf, Claude, locaux |
| `agents/session.py` | ~2 200 | la boucle de session : streaming, reprise, erreurs, rate limits |
| `agents/coder.py` | ~2 200 | l'agent d'implémentation, découpage en sous-tâches |
| `cli/build_commands.py` | ~540 | enchaîne les phases d'un build : planning → coding → QA |
| `qa/loop.py` | ~1 350 | boucle de validation QA |
| `provider_api.py` | ~2 000 | monte tous les routeurs FastAPI du domaine |

## Modèle, effort, routage

| Fichier | Contenu |
|---|---|
| `phase_config.py` | `MODEL_ID_MAP`, `THINKING_BUDGET_MAP` (`none`/`low`/`medium`/`high`/`ultrathink`), `DEFAULT_PHASE_MODELS`, `PROVIDER_DEFAULT_MODELS` (11 providers), `get_phase_model()`, `get_phase_thinking_budget()` |
| `models_registry.py` | catalogue des modèles et de leurs capacités |
| `model_router/router.py` | `TaskClass` (8 classes) × `QualityTier` (budget/balanced/premium) → choix de modèle |
| `phase_event.py` | émission des événements de phase vers l'UI |

## Agents et sous-agents

| Fichier | Rôle |
|---|---|
| `agents/kanban_subagents.py` | sous-agents par défaut d'une carte Kanban |
| `agents/planner_subagents.py` | pour `planner` / `architect` |
| `agents/qa_subagents.py` | pour `qa_reviewer` / `qa_fixer` |
| `runners/github/services/parallel_orchestrator_reviewer.py` | 6 relecteurs définis en ligne |
| `prompts/` | les prompts système réels (38 + 22 sous `github/`) |

La sélection se fait par `agent_type` dans `core/client.py`. L'appelant peut passer son
propre dict `agents` : **il gagne sur les défauts**.

## Skills

| Chemin | Rôle |
|---|---|
| `skills_registry/frontmatter.py` | **le** parseur de frontmatter. Tout lecteur passe par là. |
| `slash_commands/api.py` | sert `.agents/skills/*/SKILL.md` à la palette du Kanban |
| `skills/skill_manager.py` | chargement progressif des skills Python (`angular/`, `migration/`) |
| `skills_registry/acquire.py` | `skills-cli add/update/remove` — plan puis apply, testable hors ligne |
| `skills_registry/upstream.py` | provenance par tree SHA, partagée avec `scripts/skills_sync.py` |
| `skills_registry/agents.py` | émet le registre de sous-agents vers chaque harness, noms d'outils traduits |
| `skills_registry/classify.py` | classe une release upstream : non-cassante / potentielle / cassante |

## Apprentissage et autonomie

| Package | Rôle |
|---|---|
| `learning_loop/` | extrait les patterns succès/échec des builds, les injecte dans les prompts |
| `learning_loop/observe.py` | la phase `observe` : écrit sous `skills/_proposed/`, ne touche jamais un pack |
| `learning_loop/replay.py` | replay A/B sur les épisodes dorés — la porte que `tests/skills_eval/` exécute |
| `mem_search/` | récupération par paliers (index ~100 tokens → timeline → détail par ID) |
| `continuous_ai/daemon.py` | boucle de polling par module, avec plafond de coût journalier |
| `self_healing/` | surveillance, checks de santé, remédiation |
| `task_logger/` | capture structurée de toutes les traces d'exécution |
| `api_watcher/breaking_change_detector.py` | classe un diff de contrat en non-breaking / potentiel / breaking |

## Détection de projet

`project/framework_detector.py` (Node, Python, Ruby, PHP, Dart) ·
`project/command_registry/languages.py` (`LANGUAGE_COMMANDS`) ·
`runners/pipeline_generator_runner.py::detect_project_stack()` ·
`spec/validation_strategy.py::detect_project_type()`

## Règles

- **Jamais `anthropic.Anthropic()` en direct.** Toujours `create_client()`.
- **Type hints partout**, `ruff` 0.15.7 (`ruff check apps/backend/`, `ruff format --check`).
- Les tests vivent dans `../../tests/`, pas ici — quelques `test_*.py` traînent encore
  dans les packages, c'est un reliquat.
- `pytest.ini` fixe `pythonpath = . ./src` : les imports sont plats
  (`from phase_config import …`, `from agents.coder import …`).
