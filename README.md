# massbath-marketplace

Clément's Claude Code marketplace: mods, skills and other plugins, each in `plugins/<name>/`.

| Plugin | What it does |
| --- | --- |
| [plan-review](plugins/plan-review/README.md) | Visual tracking of a plan executed by subagents, with a review between each task |

## Installation

In a Claude Code terminal, add the marketplace:

```
/plugin marketplace add clement-vassant/massbath-marketplace
```

Then install the plugins you want, with "user" scope:

```
/plugin install plan-review@massbath-marketplace
```

Finally, turn on automatic updates: `/plugin` → Marketplaces → massbath-marketplace → **Enable auto-update**. Claude Code then fetches each new commit on `main` at startup.

## Development

To edit a plugin and see it hot-reload, clone the repo and declare the plugin's folder in `~/.claude/settings.json`, one absolute path per plugin, separated by `:`:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/massbath-marketplace/plugins/plan-review"
}
```

Don't install the same plugin from the marketplace at the same time.

### Adding a plugin

1. Create `plugins/<name>/` with its `.claude-plugin/plugin.json`, **without a `version`**.
2. Add it to `.claude-plugin/marketplace.json` (`"source": "./plugins/<name>"`).
3. Add its `/plugin install <name>@massbath-marketplace` line above and a row in the table.

### Publishing an update

Push to `main`, that's all. The `plugin.json` files deliberately have no `version`: Claude Code then identifies each version by the repo's commit, so every push is an update (for every plugin in the marketplace). That is also why `claude plugin validate` warns about the version and why `--strict` isn't used.

## Checks

```bash
claude plugin validate .                     # one "No version" warning per plugin is expected
claude plugin test plugins/plan-review
scripts/test-packaging.sh                    # no version, consistent names, real install in a throwaway HOME
scripts/test-remote-install.sh               # anonymous install from GitHub: no token, no SSH, sterile env
```

CI (`.github/workflows/check.yml`) runs the first three on every push; `.github/workflows/remote-install.yml` runs the anonymous install on every push to `main` and once a day.

## Contributing

Issues are welcome; pull requests are not accepted. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
