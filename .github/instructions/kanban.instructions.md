---
applyTo: 'apps/frontend/src/renderer/components/KanbanBoard.tsx,apps/frontend/src/renderer/components/kanban/**,apps/frontend/src/renderer/hooks/useKanban*.ts,apps/frontend/src/renderer/stores/kanban-settings-store.ts,apps/frontend/src/shared/types/kanban.ts,apps/frontend/src/renderer/components/ui/KanbanSkeleton.tsx'
description: 'Conventions Kanban WorkPilot AI : DnD-Kit, colonnes, transitions, accessibilité, settings. Charge automatiquement quand un fichier kanban est édité.'
---

# Kanban — Instructions ciblées

> **Avant toute lecture de `KanbanBoard.tsx` (3 200+ lignes)**, consulter d'abord
> `apps/frontend/src/renderer/components/kanban/AGENTS.md` (index condensé).
> Ne charger le fichier complet que si l'index ne suffit pas.

## Architecture

- **Composant principal** : `KanbanBoard.tsx` — orchestre colonnes, DnD, import externe.
- **Sous-composants internes** (non exportés) : `DroppableColumn`, `SortableColumnWrapper`.
- **Sous-dossier `kanban/`** : composants annexes (ex. `QuickCommandBar.tsx`).
- **Store des préférences colonnes** : `kanban-settings-store.ts` (Zustand).
- **Types partagés IPC** : `shared/types/kanban.ts` (`KanbanColumnPreference`, `KanbanPreferences`).
- **Constantes colonnes** : `shared/constants/task.ts` → `TASK_STATUS_COLUMNS`, `TASK_STATUS_LABELS`.
- **Hook accessibilité** : `hooks/useKanbanAccessibility.ts` (aria-live).

## Règles non négociables

1. **Colonnes valides** = `TASK_STATUS_COLUMNS` (`backlog`, `queue`, `in_progress`, `ai_review`, `human_review`, `done`). Ne jamais hardcoder une liste parallèle.
2. **Mapping visuel** : `pr_created` → `done`, `error` → `human_review`. Utiliser `getVisualColumn()` de `KanbanBoard.tsx`.
3. **Imports externes (Azure DevOps / Jira)** acceptés uniquement dans `IMPORT_ALLOWED_COLUMNS` (`backlog`, `queue`, `in_progress`).
4. **Transitions bulk** définies par `VALID_BULK_TRANSITIONS` ; toute nouvelle transition doit y être ajoutée.
5. **DnD-Kit** : utiliser `closestCorners`, `PointerSensor` + `KeyboardSensor`, `sortableKeyboardCoordinates`. Pas d'autre library DnD.
6. **Largeur colonnes** : bornée par `MIN_COLUMN_WIDTH` (180) / `MAX_COLUMN_WIDTH` (600) / `COLLAPSED_COLUMN_WIDTH` (48). Defaut `DEFAULT_COLUMN_WIDTH` (320).
7. **Re-render** : `DroppableColumn` est `memo` avec comparateur custom `droppableColumnPropsAreEqual` ; toute nouvelle prop doit y être comparée.
8. **Accessibilité** : toute action drag-drop déclenche un `announce()` via `useKanbanAccessibility` (aria-live polite, reset 3 s).

## i18n

- Namespaces utilisés : `tasks`, `dialogs`, `common`.
- Clés colonnes : `tasks:columns.<status>` (cf. `TASK_STATUS_LABELS`).
- Toujours ajouter **FR + EN** dans `shared/i18n/locales/{fr,en}/tasks.json`.

## Tests

- Tests d'ordre : `renderer/__tests__/task-order.test.ts`.
- Tests store : `renderer/stores/__tests__/task-store-kanban-order.test.ts`.
- Reproduire ces patterns pour toute nouvelle logique de tri.

## Optimisation tokens

- **Ne pas** demander à Copilot d'ouvrir `KanbanBoard.tsx` en entier sauf si nécessaire — utiliser `grep` / lignes ciblées + l'index `AGENTS.md`.
- Pour ajouter une colonne : modifier `TASK_STATUS_COLUMNS` puis suivre les usages via grep.
- Pour modifier le DnD : se concentrer sur les handlers `handleDragStart/Over/End` du fichier (cherchables par grep).
