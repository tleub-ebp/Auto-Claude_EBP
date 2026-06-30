---
name: webapp-testing
description: Teste et inspecte des applications web locales avec des scripts Playwright (Python). À utiliser pour vérifier une fonctionnalité frontend, déboguer un comportement UI, capturer des screenshots de navigateur ou lire les logs console.
---

# Test d'Applications Web (Playwright)

Écrire des scripts Playwright (Python) pour piloter une webapp locale.

**Script helper** : `scripts/with_server.py` gère le cycle de vie du/des serveur(s).
> Lancer `python scripts/with_server.py --help` avant de l'utiliser. Ne PAS lire son code source : c'est une boîte noire à invoquer directement (le lire pollue le contexte).

## Arbre de décision

```
La cible est-elle du HTML statique ?
├─ Oui → lire le HTML pour identifier les sélecteurs → écrire le script Playwright
│        (si incomplet → traiter comme dynamique)
└─ Non (webapp dynamique) → le serveur tourne-t-il déjà ?
   ├─ Non → python scripts/with_server.py --help, puis lancer le script via le helper
   └─ Oui → reconnaissance puis action :
            1. naviguer + attendre networkidle
            2. screenshot / inspecter le DOM
            3. identifier les sélecteurs depuis l'état rendu
            4. exécuter les actions
```

## with_server.py

```bash
# Serveur unique
python scripts/with_server.py --server "npm run dev" --port 5173 -- python automation.py

# Plusieurs serveurs (backend + frontend)
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python automation.py
```

Le script d'automation ne contient que la logique Playwright (les serveurs sont gérés par le helper) :

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)   # toujours headless
    page = browser.new_page()
    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')        # CRITIQUE: attendre le JS avant d'inspecter
    # ... actions
    browser.close()
```

## Bonnes pratiques

- **Attendre `networkidle` avant toute inspection** d'une app dynamique (piège n°1).
- Utiliser `sync_playwright()` et toujours fermer le navigateur.
- Sélecteurs robustes : `text=`, `role=`, CSS, ou IDs ; attentes explicites via `wait_for_selector()`.
- Inspecter le DOM rendu (`page.content()`, `page.screenshot()`, `page.locator(...).all()`) avant d'écrire les actions.
