---
description: 'Avertissement pré-chargement : alerte quand on s''apprête à `view` un fichier > 1 000 lignes et recommande un index ou un view_range ciblé.'
trigger: 'pre-tool-use'
tools: ['view']
---

# Pré-chargement gros fichier

## Quand

Avant tout appel à `view` sans `view_range` sur un fichier connu > 1 000 lignes.

## Action

1. Si un fichier `AGENTS.md` existe dans le même dossier (ou un sous-dossier), **proposer d'abord** de le consulter.
2. Sinon, suggérer un `grep` ciblé puis un `view` avec `view_range` autour des résultats.
3. Ne **jamais** lire l'intégralité d'un fichier > 1 000 lignes sans justification explicite (refactor de masse, audit complet).

## Fichiers connus à risque

| Fichier | Lignes | Index alternatif |
|---|---:|---|
| `apps/frontend/src/renderer/components/KanbanBoard.tsx` | 3 231 | `apps/frontend/src/renderer/components/kanban/AGENTS.md` |
| `apps/frontend/src/renderer/stores/task-store.ts` | 1 345 | `.github/instructions/task-store.instructions.md` |

> Mettre à jour cette table quand un nouveau fichier dépasse 1 000 lignes (voir `scripts/audit-large-files.*`).
