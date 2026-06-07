---
applyTo: 'apps/frontend/src/renderer/**/*.{ts,tsx}'
description: 'Conventions React renderer WorkPilot AI : TypeScript strict, Zustand, react-i18next, shadcn/ui, biome.'
---

# Frontend React (renderer) — Instructions

## Stack

- **React 18** + TypeScript strict (`apps/frontend/tsconfig.json`).
- **Zustand** pour le state global (un store par domaine, voir `stores/`).
- **react-i18next** (FR + EN obligatoires, `shared/i18n/locales/{fr,en}/*.json`).
- **shadcn/ui** dans `components/ui/` (Radix + Tailwind).
- **DnD-Kit** pour drag-and-drop (cf. `kanban.instructions.md`).
- **vitest** pour tests unitaires, **Playwright** pour e2e (`apps/frontend/e2e`).
- **Biome** pour lint+format (`apps/frontend/biome.jsonc`, indentation **tab**).

## Règles

1. Imports : alias `@shared/` pour `apps/frontend/src/shared/`. Imports relatifs interdits au-delà de 3 niveaux.
2. Pas de logique métier dans les composants UI (`components/ui/`) — c'est de la primitive shadcn.
3. Tout texte affiché passe par `t('namespace:key')` — pas de littéraux hardcodés.
4. IPC : appeler `globalThis.electronAPI.<method>` uniquement (jamais `ipcRenderer` direct).
5. Stores Zustand : exporter les actions async hors du `create()` (pattern existant dans `task-store.ts`).
6. Tests `__tests__/` colocaliser ou `renderer/__tests__/`.

## Token-saving

- Fichiers volumineux ont un `AGENTS.md` local (ex. `components/kanban/AGENTS.md`). **Toujours** le consulter avant un `view` complet.
- Voir `.github/hooks/pre-tool-large-file.hook.md`.

## Anti-patterns

- `useState` pour data partagée entre 2+ composants frères → utiliser un store Zustand.
- `useEffect` avec `globalThis.electronAPI` sans cleanup d'event listener.
- Hardcoder une couleur Tailwind hors du design-system (`apps/frontend/design.json`).
