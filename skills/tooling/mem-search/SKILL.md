---
name: mem-search
description: Recherche dans la mémoire de WorkPilot (builds passés, patterns appris) par paliers — un index compact d'abord, les détails seulement sur demande par ID. À utiliser avant d'attaquer un problème pour vérifier s'il a déjà été rencontré, ou pour retrouver comment une décision passée a été prise.
metadata:
  workpilot:
    requires: { command: ["python3", "python"] }
---

# mem-search — remonter la mémoire sans y noyer le contexte

WorkPilot garde trois mémoires : les traces de builds (`task_logger`), le graphe
de connaissances (graphiti) et les patterns distillés (`learning_loop`). Les
lire directement rend des enregistrements entiers — c'est-à-dire qu'il faut
payer chaque candidat pour en écarter la plupart.

Ce skill les lit **par paliers**. Chaque palier ne se paie que si le précédent
l'a justifié.

## Les trois paliers

```bash
# 1. Index — ce qui existe. ~100 tokens, quel que soit le volume en mémoire.
python3 scripts/mem_search.py index "timeout intermittent dans les tests d'intégration"

# 2. Timeline — deux lignes par ID retenu de l'index.
python3 scripts/mem_search.py timeline task:042-add-widget pattern:p-17

# 3. Detail — l'enregistrement complet, un ID à la fois.
python3 scripts/mem_search.py detail task:042-add-widget
```

Lancer `python3 scripts/mem_search.py --help` pour les options
(`--project-dir`, `--limit`, `--budget`, `--json`).

## Comment s'en servir

1. **Commencer par `index`.** Il est calibré pour tenir dans la place qu'on
   accepte de dépenser avant même de savoir s'il y a quelque chose. S'il rend
   `+N more`, la requête est trop large : la resserrer coûte moins cher que de
   lire N candidats.
2. **Passer à `timeline` sur trois à cinq IDs**, pas sur tout l'index. C'est le
   palier qui dit *ce qui s'est passé* ; il suffit presque toujours à décider si
   l'épisode est le bon.
3. **N'appeler `detail` que sur ce qu'on va vraiment lire.** Un enregistrement
   complet est un log de build entier — c'est le palier cher, et il existe pour
   être appelé rarement.

## Ce que ce skill ne fait pas

Il n'écrit rien. Les trois mémoires sont alimentées par le pipeline lui-même
(`task_logger` pendant le build, `learning_loop` après) ; ici on ne fait que
lire. Une leçon à conserver passe par la phase `observe`, qui écrit une
proposition relue par un humain — pas par un appel de recherche.

## Format des IDs

`task:<spec-id>` pour un build archivé, `pattern:<pattern-id>` pour un pattern
appris. L'index les rend tels quels : les recopier verbatim, ne pas les
reconstruire à la main.
