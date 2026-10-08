#!/usr/bin/env bash
# Protège la mise à jour automatique du mod.
# Usage : scripts/test-packaging.sh [dossier du mod]   (défaut : la racine du repo)
# shellcheck disable=SC2016 # les $ entre apostrophes sont des variables jq
set -uo pipefail

ROOT="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
PLUGIN_JSON="$ROOT/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$ROOT/.claude-plugin/marketplace.json"
README="$ROOT/README.md"

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

plugin=$(jq -r '.name' "$PLUGIN_JSON")
marketplace=$(jq -r '.name' "$MARKETPLACE_JSON")

# 1. Sans `version`, Claude Code versionne par commit : chaque push est une mise à jour.
if jq -e 'has("version")' "$PLUGIN_JSON" >/dev/null; then
  fail "plugin.json ne doit pas avoir de version (trouvé : $(jq -r .version "$PLUGIN_JSON")), sinon l'auto-update se fige"
else
  pass "plugin.json n'a pas de version"
fi

# 2. La marketplace liste ce plugin, servi depuis la racine du repo.
entry=$(jq -c --arg p "$plugin" '.plugins[] | select(.name == $p)' "$MARKETPLACE_JSON")
if [ -z "$entry" ]; then
  fail "marketplace.json ne liste pas le plugin « $plugin »"
elif [ "$(jq -r '.source' <<<"$entry")" != "./" ]; then
  fail "la source de « $plugin » dans marketplace.json doit valoir ./ (trouvé : $(jq -r '.source' <<<"$entry"))"
else
  pass "marketplace.json liste « $plugin » avec la source ./"
fi

# 3. La commande d'installation du README vise ce plugin et le repo GitHub, et l'auto-update y est expliqué.
repo=$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
install="/plugin install $plugin --marketplace $repo"
if grep -qxF "$install" "$README"; then
  pass "README : la commande d'installation est « $install »"
else
  fail "README : commande d'installation « $install » introuvable"
fi
if grep -qF "Enable auto-update" "$README"; then
  pass "README : l'activation de l'auto-update est expliquée"
else
  fail "README : l'activation de l'auto-update (« Enable auto-update ») n'est pas expliquée"
fi

# 4. Bout en bout : la marketplace s'installe vraiment, dans un HOME jetable.
#    Le vrai ~/.claude n'est jamais touché. Pas de réseau ni de compte nécessaires.
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
in_sandbox() { env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_PLUGIN_DIRS HOME="$sandbox" claude "$@"; }
if ! in_sandbox plugin marketplace add "$ROOT" >"$sandbox/log" 2>&1 ||
   ! in_sandbox plugin install "$plugin@$marketplace" >>"$sandbox/log" 2>&1; then
  fail "installation de $plugin@$marketplace depuis $ROOT"
  sed 's/^/       /' "$sandbox/log"
else
  installed=$(in_sandbox plugin list --json | jq -c --arg id "$plugin@$marketplace" '.[] | select(.id == $id)')
  if [ "$(jq -r '.enabled' <<<"$installed")" = "true" ]; then
    pass "installation de $plugin@$marketplace depuis la marketplace locale"
  else
    fail "installation de $plugin@$marketplace : absent ou désactivé dans « claude plugin list »"
  fi
  # La version installée doit être le commit courant : c'est ce qui fait de chaque push une mise à jour.
  version=$(jq -r '.version' <<<"$installed")
  if [ -n "$version" ] && [[ "$(git -C "$ROOT" rev-parse HEAD)" == "$version"* ]]; then
    pass "la version installée est le commit courant ($version)"
  else
    fail "la version installée devrait être le commit courant, trouvé : $version"
  fi
fi

echo
if [ "$failures" -gt 0 ]; then echo "$failures test(s) en échec"; exit 1; fi
echo "Tous les tests de packaging passent"
