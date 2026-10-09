#!/usr/bin/env bash
# Installs the marketplace from GitHub the way a stranger would: anonymous, in a sterile environment.
# No token, no ssh-agent, no SSH keys or config, no git credential helper, a throwaway HOME.
# Usage: scripts/test-remote-install.sh [owner/repo] [expected commit sha]
#   defaults: the origin remote of this repo, and the commit main points to on GitHub right now
# shellcheck disable=SC2016 # the $ inside single quotes are jq variables
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE_JSON="$ROOT/.claude-plugin/marketplace.json"
repo="${1:-$(git -C "$ROOT" remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')}"
marketplace=$(jq -r '.name' "$MARKETPLACE_JSON")
plugins=$(jq -r '.plugins[].name' "$MARKETPLACE_JSON")

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/home"

# Only PATH, HOME and TERM survive: GITHUB_TOKEN, GH_TOKEN, SSH_AUTH_SOCK, CLAUDE_* and the rest are dropped.
# git reads no system or global config (so no credential helper), never prompts,
# and ssh reads neither ~/.ssh nor an agent, and never asks a question.
sterile() {
  env -i \
    PATH="$PATH" HOME="$sandbox/home" TERM="${TERM:-dumb}" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/dev/null" \
    "$@"
}

expected="${2:-$(sterile git ls-remote "https://github.com/$repo.git" refs/heads/main | cut -f1)}"
if [ -n "$expected" ]; then
  pass "anonymous read of github.com/$repo (main is ${expected:0:12})"
else
  fail "anonymous read of github.com/$repo: is the repo public?"
  exit 1
fi

if sterile claude plugin marketplace add "$repo" >"$sandbox/log" 2>&1; then
  pass "anonymous \"claude plugin marketplace add $repo\""
else
  fail "anonymous \"claude plugin marketplace add $repo\""
  sed 's/^/       /' "$sandbox/log"
  exit 1
fi

known="$sandbox/home/.claude/plugins/known_marketplaces.json"
source=$(jq -c --arg m "$marketplace" '.[$m].source' "$known" 2>/dev/null)
if [ "$source" = "$(jq -nc --arg r "$repo" '{source: "github", repo: $r}')" ]; then
  pass "known_marketplaces.json: $marketplace comes from github, $repo"
else
  fail "known_marketplaces.json: $marketplace should come from github $repo, found: $source"
fi

installed="$sandbox/home/.claude/plugins/installed_plugins.json"
for plugin in $plugins; do
  if ! sterile claude plugin install "$plugin@$marketplace" >"$sandbox/log" 2>&1; then
    fail "anonymous install of $plugin@$marketplace"
    sed 's/^/       /' "$sandbox/log"
    continue
  fi
  pass "anonymous install of $plugin@$marketplace"

  entry=$(jq -c --arg id "$plugin@$marketplace" '.plugins[$id][0]' "$installed" 2>/dev/null)
  sha=$(jq -r '.gitCommitSha // empty' <<<"$entry")
  if [ "$sha" = "$expected" ]; then
    pass "$plugin: installed at the pushed commit (${sha:0:12})"
  else
    fail "$plugin: installed at ${sha:-nothing}, expected $expected"
  fi

  path=$(jq -r '.installPath // empty' <<<"$entry")
  for file in .claude-plugin/plugin.json $(jq -r '.modules[]?' "$path/hooks/hooks.json" 2>/dev/null | sed 's#^\./#hooks/#') hooks/hooks.json; do
    if [ -f "$path/$file" ]; then pass "$plugin: $file is in the cache"; else fail "$plugin: $file is missing from the cache ($path)"; fi
  done
done

echo
if [ "$failures" -gt 0 ]; then echo "$failures test(s) failed"; exit 1; fi
echo "Anonymous install from GitHub works"
