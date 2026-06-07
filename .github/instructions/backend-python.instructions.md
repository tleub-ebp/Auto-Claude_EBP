---
applyTo: 'apps/backend/**/*.py,src/**/*.py'
description: 'Conventions backend Python WorkPilot AI : FastAPI, agents multi-LLM, ruff, pytest.'
---

# Backend Python — Instructions

## Stack

- **Python ≥ 3.11** (cf. `pyproject.toml`).
- **FastAPI** comme façade HTTP (`apps/backend/api/`, `apps/backend/websocket_server.py`).
- Agents organisés en modules par domaine au niveau racine de `apps/backend/` (un dossier par capability : `accessibility_agent/`, `adversarial_qa/`, `architecture/`, etc.).
- LLM providers via `apps/backend/provider_api.py` + `provider_models_catalog.py`.
- **Ruff** pour lint+format (`ruff.toml`, double quotes, indent spaces).
- **pytest** pour tests (`pytest.ini`, `tests/`).

## Règles

1. Imports : absolus depuis `apps.backend.<module>`. Pas de wildcard.
2. Toute fonction publique a un docstring + types annotés.
3. Pas de `print()` — utiliser le `logging` standard avec niveau approprié.
4. Aucune clé API en clair — passer par `apps/backend/security.py` + `.env` géré par `apps/backend/environment/`.
5. Endpoints FastAPI dans `apps/backend/api/` ; logique métier dans les modules dédiés.
6. Slash commands : `apps/backend/slash_commands/` (résout `.claude/commands/*.md`).
7. Tout module nouveau doit déclarer ses dépendances via `__init__.py` minimal.

## Tests

- Pattern : `tests/test_<module>.py` ou colocalisé.
- `conftest.py` à la racine pour les fixtures partagées.
- Mocker les LLM via les fixtures existantes (pas d'appel réseau).

## Token-saving

- Beaucoup de modules — utiliser `grep` ciblé.
- Voir `apps/backend/AGENTS.md` pour la cartographie.

## Anti-patterns

- Appeler un provider LLM directement sans passer par `provider_api.py`.
- Sleep synchrone dans un endpoint FastAPI — utiliser `asyncio.sleep`.
- Lecture / écriture filesystem hors des helpers `workspace.py` / `worktree.py`.
