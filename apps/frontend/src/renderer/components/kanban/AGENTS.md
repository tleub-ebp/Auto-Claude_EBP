# AGENTS.md — index du Kanban

`KanbanBoard.tsx` fait ~4 200 lignes. **Ne pas l'ouvrir en entier.** Ce fichier donne les
points d'entrée : cibler la ligne, lire 40 lignes autour, éditer.

Les numéros de ligne dérivent à chaque modification. Ils indiquent un voisinage, pas une
adresse : confirmer avec `grep -n "<nom>" KanbanBoard.tsx` avant d'éditer.

## Fichiers du domaine

| Fichier | Lignes | Rôle |
|---|---|---|
| `../KanbanBoard.tsx` | ~4 200 | le tableau complet : colonnes, drag-and-drop, sélection en masse, dialogues |
| `KanbanToolbar.tsx` | ~400 | barre d'outils au-dessus du tableau |
| `QuickCommandBar.tsx` | ~300 | palette `/slash` — lit `.agents/skills/` via le backend |
| `../RoadmapKanbanView.tsx` | ~350 | vue roadmap, tableau distinct |
| `../../stores/task-store.ts` | ~1 300 | état des tâches (Zustand) |
| `../../stores/kanban-settings-store.ts` | — | largeur, ordre, collapse, WIP par colonne |
| `../../../shared/constants/task.ts` | — | `TASK_STATUS_COLUMNS`, libellés de statut |
| `../../hooks/useKanbanAccessibility.ts` | — | annonces aria-live pour le drag-and-drop |

## Colonnes

`TASK_STATUS_COLUMNS` (`shared/constants/task.ts:13`) :
`backlog` · `queue` · `in_progress` · `ai_review` · `human_review` · `build_failed` · `done`

Deux statuts n'ont pas de colonne à eux et sont projetés par `getVisualColumn()` :
`pr_created → done`, `error → human_review`.

`IMPORT_ALLOWED_COLUMNS` restreint les cibles d'import (Azure DevOps / Jira) à
`backlog`, `queue`, `in_progress`. `VALID_BULK_TRANSITIONS` filtre les déplacements en masse.

## Carte de `KanbanBoard.tsx`

| Zone | Ligne ~ | Contenu |
|---|---|---|
| Constantes et gardes | 146-210 | `VALID_DROP_COLUMNS`, `COLUMN_RENDER_CAP` (60), `IMPORT_ALLOWED_COLUMNS`, `VALID_BULK_TRANSITIONS`, `getVisualColumn` |
| Comparateurs mémo | 273-350 | `tasksAreEquivalent`, `droppableColumnPropsAreEqual` — **le rendu en dépend, y toucher se paie en perfs** |
| `WipLimitPopover` | 408-508 | réglage de la limite WIP d'une colonne |
| `DroppableColumn` | 509-1199 | une colonne : en-tête, liste, cible de drop, redimensionnement |
| `SortableColumnWrapper` | 1200-1241 | réordonnancement des colonnes |
| `KanbanBoard` | 1242→fin | le composant exporté |

### À l'intérieur de `KanbanBoard`

| Bloc | Ligne ~ |
|---|---|
| Stores et préférences (projet, env, colonnes, filtres) | 1252-1340 |
| 13 `useEffect` (chargement des préférences, file d'attente, sync) | 1338+ |
| État des dialogues (suppression, duplication, PR en masse, worktree, Azure, Jira) | 1388-1470 |
| Actions en masse : `handleBulkMove`, `handleConfirmDelete`, `handleUndoBulkDelete` | 1747-1870 |
| Actions par tâche : `handleDeleteTask`, `handleDuplicateTask`, `handleUndoDelete` | 1899-2028 |
| Import (Azure DevOps / Jira) : `handleImportConfirm` | 2029 |
| Drag-and-drop : `handleDragStart` / `handleDragOver` / `handleDragEnd` | 2216, 2253, 3043 |
| Changement de statut : `handleStatusChange` | 2301 |
| File d'attente : `handleQueueAll`, `handleSaveQueueSettings` | 2446, 2478 |
| Colonnes : collapse, verrou, WIP, redimensionnement | 2852-2960 |
| JSX : dialogues et panneaux | 3845→fin |

## Règles du domaine

- **i18n** — namespaces `["tasks", "dialogs", "common"]`. Aucun texte en dur.
- **Accessibilité** — tout déplacement passe par `announce()` ; ne pas court-circuiter.
- **Rendu** — `COLUMN_RENDER_CAP = 60` borne les cartes affichées par colonne. Les
  comparateurs mémo sont le garde-fou perf du tableau ; les modifier sans mesurer régresse.
- **Vérité serveur** — la palette `/slash` résout le corps des commandes côté backend
  depuis `.agents/skills/`, pas dans le renderer.
