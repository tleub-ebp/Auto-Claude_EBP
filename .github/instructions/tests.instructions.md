---
applyTo: '**/__tests__/**,**/test_*.py,**/*.test.{ts,tsx},**/*.spec.{ts,tsx},apps/frontend/e2e/**,tests/**'
description: 'Conventions tests WorkPilot AI : vitest (front), pytest (back), Playwright (e2e).'
---

# Tests — Instructions

## Frontend (vitest)

- Fichiers : `*.test.ts(x)` colocalisés ou dans `__tests__/`.
- `vitest.config.ts` à la racine `apps/frontend/`.
- Mocks Electron API : `vi.stubGlobal('electronAPI', { ... })` ou helpers dans `apps/frontend/src/__mocks__/`.
- Tests Zustand : `useTaskStore.setState({ ... })` dans `beforeEach`.

## Backend (pytest)

- Fichiers : `tests/test_<module>.py` ou colocalisés.
- `conftest.py` racine pour fixtures partagées.
- Marqueurs : `@pytest.mark.slow`, `@pytest.mark.integration` (cf. `pytest.ini`).
- Pas d'appel LLM réel — utiliser les fixtures de mock.

## E2E (Playwright)

- Dossier : `apps/frontend/e2e/`.
- Lancer Electron via `playwright._electron.launch(...)`.
- Sélecteurs : `data-testid` prioritaire, sinon role/text accessible.

## Règles communes

1. Un test = un comportement observable, pas une implémentation.
2. Pas de `setTimeout` arbitraire — utiliser `waitFor` / `findBy`.
3. Cleanup explicite (`afterEach`).
4. Snapshot tests uniquement pour des structures stables (i18n, types).
