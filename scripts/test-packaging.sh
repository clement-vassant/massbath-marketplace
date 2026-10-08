#!/usr/bin/env bash
# Guards the marketplace and the automatic update of its plugins.
# Usage: scripts/test-packaging.sh [marketplace root]   (default: the repo root)
# shellcheck disable=SC2016 # the $ inside single quotes are jq variables
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

# 1. Each listed plugin exists where the marketplace says, under the same name, and without a version:
#    Claude Code then versions by commit, so every push is an update.
for plugin in $plugins; do
  source=$(jq -r --arg p "$plugin" '.plugins[] | select(.name == $p) | .source' "$MARKETPLACE_JSON")
  manifest="$ROOT/$source/.claude-plugin/plugin.json"
  if [ ! -f "$manifest" ]; then
    fail "$plugin: no plugin.json under $source"
    continue
  fi
  if [ "$(jq -r '.name' "$manifest")" = "$plugin" ]; then
    pass "$plugin: served from $source under the same name"
  else
    fail "$plugin: $source/.claude-plugin/plugin.json is named \"$(jq -r '.name' "$manifest")\""
  fi
  if jq -e 'has("version")' "$manifest" >/dev/null; then
    fail "$plugin: plugin.json must not have a version (found: $(jq -r .version "$manifest")), or auto-update freezes"
  else
    pass "$plugin: plugin.json has no version"
  fi
done

# 2. The README gives the right install commands and explains auto-update.
readme_has() { # description, exact expected line
  if grep -qxF "$2" "$README"; then pass "README: $1"; else fail "README: $1 (\"$2\" not found)"; fi
}
readme_has "adding the marketplace" "/plugin marketplace add $repo"
for plugin in $plugins; do
  readme_has "installing $plugin" "/plugin install $plugin@$marketplace"
done
if grep -qF "Enable auto-update" "$README"; then
  pass "README: turning on auto-update is explained"
else
  fail "README: turning on auto-update (\"Enable auto-update\") is not explained"
fi

# 3. End to end: the marketplace is added and each plugin really installs, in a throwaway HOME.
#    The real ~/.claude is never touched. No network or account needed.
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
in_sandbox() { env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_PLUGIN_DIRS HOME="$sandbox" claude "$@"; }
if ! in_sandbox plugin marketplace add "$ROOT" >"$sandbox/log" 2>&1; then
  fail "adding the $marketplace marketplace from $ROOT"
  sed 's/^/       /' "$sandbox/log"
else
  head=$(git -C "$ROOT" rev-parse HEAD)
  for plugin in $plugins; do
    if ! in_sandbox plugin install "$plugin@$marketplace" >"$sandbox/log" 2>&1; then
      fail "installing $plugin@$marketplace"
      sed 's/^/       /' "$sandbox/log"
      continue
    fi
    installed=$(in_sandbox plugin list --json | jq -c --arg id "$plugin@$marketplace" '.[] | select(.id == $id)')
    if [ "$(jq -r '.enabled' <<<"$installed")" = "true" ]; then
      pass "installing $plugin@$marketplace"
    else
      fail "installing $plugin@$marketplace: missing or disabled in \"claude plugin list\""
    fi
    # The installed version must be the current commit: that is what makes every push an update.
    version=$(jq -r '.version' <<<"$installed")
    if [ -n "$version" ] && [[ "$head" == "$version"* ]]; then
      pass "$plugin: the installed version is the current commit ($version)"
    else
      fail "$plugin: the installed version should be the current commit, found: $version"
    fi
  done
fi

echo
if [ "$failures" -gt 0 ]; then echo "$failures test(s) failed"; exit 1; fi
echo "All packaging tests pass"
