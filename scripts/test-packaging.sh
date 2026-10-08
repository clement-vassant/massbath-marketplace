#!/usr/bin/env bash
# Protège la marketplace et la mise à jour automatique de ses plugins.
# Usage : scripts/test-packaging.sh [racine de la marketplace]   (défaut : la racine du repo)
# shellcheck disable=SC2016 # les $ entre apostrophes sont des variables jq
set -uo pipefail

ROOT="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
MARKETPLACE_JSON="$ROOT/.claude-plugin/marketplace.json"
README="$ROOT/README.md"

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

marketplace=$(jq -r '.name' "$MARKETPLACE_JSON")
plugins=$(jq -r '.plugins[].name' "$MARKETPLACE_JSON")
repo=$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')

# 1. Chaque plugin listé existe là où la marketplace le dit, sous le même nom, et sans version :
#    Claude Code versionne alors par commit, donc chaque push est une mise à jour.
for plugin in $plugins; do
  source=$(jq -r --arg p "$plugin" '.plugins[] | select(.name == $p) | .source' "$MARKETPLACE_JSON")
  manifest="$ROOT/$source/.claude-plugin/plugin.json"
  if [ ! -f "$manifest" ]; then
    fail "$plugin : pas de plugin.json sous $source"
    continue
  fi
  if [ "$(jq -r '.name' "$manifest")" = "$plugin" ]; then
    pass "$plugin : servi depuis $source sous le même nom"
  else
    fail "$plugin : $source/.claude-plugin/plugin.json porte le nom « $(jq -r '.name' "$manifest") »"
  fi
  if jq -e 'has("version")' "$manifest" >/dev/null; then
    fail "$plugin : plugin.json ne doit pas avoir de version (trouvé : $(jq -r .version "$manifest")), sinon l'auto-update se fige"
  else
    pass "$plugin : plugin.json n'a pas de version"
  fi
done

# 2. Le README donne les bonnes commandes d'installation et explique l'auto-update.
readme_has() { # description, ligne exacte attendue
  if grep -qxF "$2" "$README"; then pass "README : $1"; else fail "README : $1 (« $2 » introuvable)"; fi
}
readme_has "ajout de la marketplace" "/plugin marketplace add $repo"
for plugin in $plugins; do
  readme_has "installation de $plugin" "/plugin install $plugin@$marketplace"
done
if grep -qF "Enable auto-update" "$README"; then
  pass "README : l'activation de l'auto-update est expliquée"
else
  fail "README : l'activation de l'auto-update (« Enable auto-update ») n'est pas expliquée"
fi

# 3. Bout en bout : la marketplace s'ajoute et chaque plugin s'installe vraiment, dans un HOME jetable.
#    Le vrai ~/.claude n'est jamais touché. Pas de réseau ni de compte nécessaires.
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
in_sandbox() { env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_PLUGIN_DIRS HOME="$sandbox" claude "$@"; }
if ! in_sandbox plugin marketplace add "$ROOT" >"$sandbox/log" 2>&1; then
  fail "ajout de la marketplace $marketplace depuis $ROOT"
  sed 's/^/       /' "$sandbox/log"
else
  head=$(git -C "$ROOT" rev-parse HEAD)
  for plugin in $plugins; do
    if ! in_sandbox plugin install "$plugin@$marketplace" >"$sandbox/log" 2>&1; then
      fail "installation de $plugin@$marketplace"
      sed 's/^/       /' "$sandbox/log"
      continue
    fi
    installed=$(in_sandbox plugin list --json | jq -c --arg id "$plugin@$marketplace" '.[] | select(.id == $id)')
    if [ "$(jq -r '.enabled' <<<"$installed")" = "true" ]; then
      pass "installation de $plugin@$marketplace"
    else
      fail "installation de $plugin@$marketplace : absent ou désactivé dans « claude plugin list »"
    fi
    # La version installée doit être le commit courant : c'est ce qui fait de chaque push une mise à jour.
    version=$(jq -r '.version' <<<"$installed")
    if [ -n "$version" ] && [[ "$head" == "$version"* ]]; then
      pass "$plugin : la version installée est le commit courant ($version)"
    else
      fail "$plugin : la version installée devrait être le commit courant, trouvé : $version"
    fi
  done
fi

echo
if [ "$failures" -gt 0 ]; then echo "$failures test(s) en échec"; exit 1; fi
echo "Tous les tests de packaging passent"
