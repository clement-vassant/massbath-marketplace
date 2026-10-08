# massbath-marketplace

Marketplace Claude Code de Clément : mods, skills et autres plugins, chacun dans `plugins/<nom>/`.

| Plugin | Ce qu'il fait |
| --- | --- |
| [plan-review](plugins/plan-review/README.md) | Suivi visuel d'un plan exécuté par sous-agents, avec revue entre chaque tâche |

## Installation

Dans un terminal Claude Code, ajoute la marketplace :

```
/plugin marketplace add clement-vassant/massbath-marketplace
```

Puis installe les plugins voulus, en portée « user » :

```
/plugin install plan-review@massbath-marketplace
```

Le repo étant privé, il faut y avoir accès (`gh auth login` ou une clé SSH GitHub).

Active enfin la mise à jour automatique : `/plugin` → Marketplaces → massbath-marketplace → **Enable auto-update**. Claude Code récupère alors chaque nouveau commit de `main` au démarrage.

## Développer

Pour modifier un plugin et le voir se recharger à chaud, clone le repo et déclare le dossier du plugin dans `~/.claude/settings.json`, un chemin absolu par plugin, séparés par `:` :

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<toi>/massbath-marketplace/plugins/plan-review"
}
```

N'installe pas en même temps le même plugin depuis la marketplace.

### Ajouter un plugin

1. Crée `plugins/<nom>/` avec son `.claude-plugin/plugin.json`, **sans `version`**.
2. Ajoute-le dans `.claude-plugin/marketplace.json` (`"source": "./plugins/<nom>"`).
3. Ajoute sa ligne `/plugin install <nom>@massbath-marketplace` ci-dessus et dans le tableau.

### Publier une mise à jour

Pousse sur `main`, c'est tout. Les `plugin.json` n'ont volontairement pas de `version` : Claude Code identifie alors chaque version par le commit du repo, donc chaque push est une mise à jour (pour tous les plugins de la marketplace). C'est aussi pourquoi `claude plugin validate` affiche un avertissement sur la version et qu'on ne lance pas `--strict`.

## Vérifier

```bash
claude plugin validate .                     # un avertissement « No version » par plugin est attendu
claude plugin test plugins/plan-review
scripts/test-packaging.sh                    # pas de version, noms cohérents, installation réelle dans un HOME jetable
```

La CI (`.github/workflows/check.yml`) lance les mêmes vérifications à chaque push.
