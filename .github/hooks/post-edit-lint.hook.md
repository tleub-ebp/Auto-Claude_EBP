---
description: 'Rappel post-édition : exécuter le linter approprié selon le dossier modifié (biome côté frontend, ruff côté backend).'
trigger: 'post-tool-use'
tools: ['edit', 'create']
---

# Post-édition : rappel lint

## Quand

Après tout `edit` ou `create` sur un fichier source (`.ts`, `.tsx`, `.py`, `.js`).

## Action

- Si fichier dans `apps/frontend/**` → rappeler `pnpm --filter ./apps/frontend lint` (Biome).
- Si fichier dans `apps/backend/**` ou `src/**/*.py` → rappeler `ruff check <fichier>` + `ruff format <fichier>`.
- Si fichier `scripts/*.{js,py}` → linter du langage correspondant.
- Pour les **gros refactors** (> 3 fichiers édités) : suggérer `pnpm test` + tests backend selon zone.

## Ne pas

- Bloquer l'exécution si le lint échoue — juste signaler.
- Lancer le linter automatiquement sur des fichiers non modifiés.
