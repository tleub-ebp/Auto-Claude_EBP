---
mode: 'agent'
description: 'Template pour une tâche de modification du module Kanban WorkPilot AI.'
---

# Tâche Kanban : ${input:description}

## Avant de coder

1. Lire `apps/frontend/src/renderer/components/kanban/AGENTS.md` (index).
2. Identifier la zone exacte via `grep` (ne pas charger `KanbanBoard.tsx` en entier).
3. Vérifier les règles dans `.github/instructions/kanban.instructions.md`.

## Implémenter

- Modifier `apps/frontend/src/renderer/components/KanbanBoard.tsx` et fichiers associés **uniquement** sur les lignes pertinentes.
- Respecter `TASK_STATUS_COLUMNS`, `VALID_BULK_TRANSITIONS`, `IMPORT_ALLOWED_COLUMNS`.
- Si nouvelle prop sur `DroppableColumn` → étendre `droppableColumnPropsAreEqual`.
- Si action sur le store → passer par les fonctions exportées du `task-store.ts`.

## Accessibilité

- Toute interaction nouvelle déclenche `announce()` via `useKanbanAccessibility`.
- Vérifier la navigation clavier (`KeyboardSensor` + `sortableKeyboardCoordinates`).

## i18n

- Ajouter les clés dans `apps/frontend/src/shared/i18n/locales/fr/tasks.json` **et** `.../en/tasks.json`.

## Tests

- Ajouter ou étendre un test dans :
  - `apps/frontend/src/renderer/__tests__/task-order.test.ts` (ordre / DnD)
  - `apps/frontend/src/renderer/stores/__tests__/` (store)

## Livrable

- Diff minimal commenté.
- Liste des tests ajoutés.
- Mise à jour de `kanban/AGENTS.md` **si** l'API publique change.
