# AGENTS.md — index du frontend

Electron + React + TypeScript + Vite + Zustand + Tailwind. 196 composants, 99 stores,
~150 modules de handlers IPC. Ce fichier donne les points d'entrée.

> Règles normatives : [`../../docs/CLAUDE.md`](../../docs/CLAUDE.md) · Racine : [`../../AGENTS.md`](../../AGENTS.md)
> Contribution frontend : [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Les trois processus

| Dossier | Processus | Rôle |
|---|---|---|
| `src/main/` | Electron main | accès disque, git, worktrees, spawn du backend, terminaux, IPC |
| `src/preload/` | preload | expose l'API IPC au renderer via `contextBridge` |
| `src/renderer/` | renderer | l'UI React. **Aucun accès direct au système** — tout passe par l'IPC. |

## Fichiers volumineux — ne pas ouvrir en entier

| Fichier | Lignes | Index |
|---|---|---|
| `src/main/ipc-handlers/task/worktree-handlers.ts` | ~5 700 | — |
| `src/main/claude-profile/usage-monitor.ts` | ~4 500 | — |
| `src/renderer/components/KanbanBoard.tsx` | ~4 200 | [`kanban/AGENTS.md`](src/renderer/components/kanban/AGENTS.md) |
| `src/renderer/components/api-explorer/ApiExplorer.tsx` | ~3 600 | — |
| `src/main/ipc-handlers/task/execution-handlers.ts` | ~3 500 | — |
| `src/main/ipc-handlers/github/pr-handlers.ts` | ~3 500 | — |
| `src/main/app-emulator-service.ts` | ~3 200 | — |
| `src/renderer/stores/task-store.ts` | ~1 300 | — |

Cibler avec `grep -n`, lire le voisinage, éditer. Le hook `pre-tool-large-file` bloque
les lectures complètes au-delà de 1 000 lignes.

## Conventions

- **i18n obligatoire.** Tout texte visible passe par `react-i18next`. Locales sous
  `src/renderer/locales/{en,fr}/`. Un texte en dur est un bug, pas un détail.
- **Jamais `process.platform` en direct** — passer par `src/main/platform/`.
- **IPC nommé** — les canaux vivent dans `src/shared/constants/ipc.ts` et
  `ipc-namespaces.ts`. Pas de chaîne littérale.
- **Zustand** — un store par domaine sous `src/renderer/stores/`. Sélecteurs granulaires :
  `useX((s) => s.champ)`, jamais le store entier, sinon tout re-rend.
- **Biome 2.4.10** exactement (`pnpm run lint`). Une autre version reformate tout.

## Tests

| Type | Où | Commande |
|---|---|---|
| Unitaires | `src/**/__tests__/` | `pnpm test` (vitest) |
| Intégration | `src/__tests__/integration/` | `pnpm test` |
| E2E | `e2e/` | `pnpm run test:e2e` (Playwright) |
