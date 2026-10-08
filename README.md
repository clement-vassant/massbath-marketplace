# plan-review

Mod Claude Code (v2.1.287+) pour exécuter un plan avec des sous-agents et une revue humaine entre chaque tâche.

## Ce que ça fait

- **Bandeau au-dessus du prompt** : barre de progression du plan, tâche en cours, nombre de sous-agents actifs, et un repère quand une revue t'attend. `0` (prompt vide) ouvre le panneau.
- **Panneau `/plan`**, trois onglets :
  - `1` **Plan** : chaque tâche avec son statut (○ à faire, ◐ en cours, ◆ en revue, ✎ à corriger, ● validée), le nombre d'agents lancés et ton dernier commentaire.
  - `2` **Agents** : chaque sous-agent avec sa tâche, son type, le nombre d'appels d'outils, sa durée, le dernier outil utilisé, puis un extrait de son rapport une fois terminé.
  - `3` **Revue** : la synthèse de la tâche (markdown, fichiers modifiés, tests, points d'attention), un champ commentaire et deux boutons : `v` **Valider et continuer**, `c` **Demander des changements**.
- **Porte de revue réelle** : tant qu'une revue est en attente, l'orchestrateur ne peut plus lancer de sous-agent, éditer de fichier ni démarrer une tâche. Ces appels sont refusés côté mod, ce n'est pas seulement une consigne dans le prompt.
- Ta décision relance Claude automatiquement avec un message clair : tâche validée (avec ta remarque éventuelle) ou changements demandés (avec ton commentaire).
- Le plan est sauvegardé par dossier de travail. Il survit à un redémarrage, à `/clear` et à `/resume`.

## Comment Claude s'en sert

Le mod ajoute quatre outils et une courte consigne au prompt système :

- `plan_set` : déclare le plan (T1, T2…) au début
- `task_start` : avant de lancer les sous-agents d'une tâche
- `task_review` : à la fin d'une tâche, à la place de demander la validation dans le chat
- `plan_review` : une fois toutes les tâches validées, soumet le bilan du plan entier à une revue finale. La valider referme le suivi (plan effacé, panneau fermé) sans relancer Claude. Demander des changements renvoie ton commentaire, comme pour une tâche.

Il suffit de demander, par exemple : « Exécute le plan de `docs/plan.md` avec des sous-agents, revue entre chaque tâche. »

## Installation

### Pour développer (recommandé)

```bash
git clone git@github.com:clement-vassant/plan-review.git ~/claude-mods/plan-review
```

Puis dans `~/.claude/settings.json`, un chemin absolu par mod, séparés par `:` :

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<toi>/claude-mods/plan-review"
}
```

Mise à jour : `git pull`, puis `/reload-plugins` dans la session.

### Pour l'utiliser sans le modifier (mises à jour automatiques)

Le repo est sa propre marketplace. Ajoute ceci dans `~/.claude/settings.json` :

```json
"extraKnownMarketplaces": {
  "plan-review": {
    "source": { "source": "github", "repo": "clement-vassant/plan-review" },
    "autoUpdate": true
  }
},
"enabledPlugins": {
  "plan-review@plan-review": true
}
```

Au démarrage suivant, Claude Code installe le mod, puis le met à jour tout seul à chaque nouveau commit sur `main`. Le repo étant privé, il faut y avoir accès (`gh auth login` ou une clé SSH GitHub).

Si tu l'as déjà installé à la main (`/plugin install plan-review --marketplace clement-vassant/plan-review`), active la mise à jour automatique dans `/plugin` → Marketplaces → plan-review → Enable auto-update.

### Publier une mise à jour

Pousse sur `main`, c'est tout. `plugin.json` n'a volontairement pas de `version` : Claude Code identifie alors chaque version par son commit, donc chaque push est une mise à jour. C'est aussi pourquoi `claude plugin validate` affiche un avertissement sur la version et qu'on ne lance pas `--strict`.

## Vérifier

```bash
claude plugin validate ./plan-review   # un avertissement « No version » est attendu
claude plugin test ./plan-review
./plan-review/scripts/test-packaging.sh   # auto-update : pas de version, noms cohérents, installation réelle dans un HOME jetable
```

`/plan-reset` efface le plan suivi pour le dossier courant.

## Limites connues

- Le mod ne voit les sous-agents qu'à leur lancement, à leurs appels d'outils et à leur fin. Pas de streaming de leur réflexion.
- La qualité de la synthèse dépend de ce que l'orchestrateur écrit dans `task_review`.
- Comme tout mod, il tourne avec tes droits et sans sandbox.
