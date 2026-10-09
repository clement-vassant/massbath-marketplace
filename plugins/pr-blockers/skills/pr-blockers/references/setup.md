# Setup: per-repo self-configuration

Goal: for the repo at hand, know which forge it lives on, which tracker its tickets live
in, and which tool reaches each source — and say exactly what is missing. People work on
repos that run differently (one on GitHub with Linear, another on a self-hosted GitLab with
Jira), so this is decided per repo, never globally.

Never install anything, never log in, never change a CLI's config on the user's behalf:
those are the user's calls. Detection only reads (`--version`, `auth status`, `ssh -G`,
ToolSearch). The only files written are the repo profile below and, once, a line in the
clone's local `info/exclude` so git ignores it.

## 1. Identify the repo and the forge

```bash
git remote get-url origin 2>/dev/null   # else: take the PR/MR URL given as argument
```

Normalize to `host` and `project` (the repo path), both kept in the profile:

- `git@host:group/sub/name.git`, `ssh://git@host:2222/group/name.git`,
  `https://host/group/name(.git)` → host + path without `.git`. GitLab paths can have
  nested groups: keep the whole path.
- An SSH host alias (`git@work-gh:org/repo.git`, defined in `~/.ssh/config`) is not the
  real host: resolve it with `ssh -G <alias> | awk '/^hostname /{print $2}'` (local, no
  connection).
- From a URL argument: `/pull/<n>` → GitHub, `/-/merge_requests/<n>` → GitLab.

Forge from the host:

- `github.com` → GitHub. `gitlab.com` → GitLab.
- Any other host: `gh auth status --hostname <host>` succeeds → GitHub Enterprise;
  `glab auth status --hostname <host>` succeeds → self-hosted GitLab; a host name
  containing `gitlab` or `github` is a strong hint. Still unknown → ask the user, and save
  the answer.

## 2. Read the profile

One profile per repo, personal and never committed:
`<main checkout>/.claude/pr-blockers.local.json` (the `.local` suffix is Claude Code's
convention for personal files). Two repos can belong to two different companies — another
forge, tracker, Jira site and Slack workspace — so nothing is shared between repos. All
worktrees of a repo share the main checkout's profile:

```bash
if common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  case "$common" in
    */.git) ROOT=$(dirname "$common"); CFG="$ROOT/.claude/pr-blockers.local.json" ;;
    *)      ROOT=; CFG="$common/pr-blockers.local.json" ;;  # bare repo or unusual layout: in git's own dir
  esac
  jq . "$CFG" 2>/dev/null
else
  CFG=   # not inside a git repo (URL argument only): run without a profile, say so in one line
fi
```

```json
{
  "forge": "gitlab",
  "host": "gitlab.example.com",
  "project": "team/backend",
  "tracker": "jira",
  "trackerSite": "example.atlassian.net",
  "tools": {
    "forge": "glab",
    "tracker": "acli",
    "confluence": "mcp",
    "slack": "mcp",
    "gmail": "mcp"
  },
  "slack": { "jiraNotificationsDm": "<DM channel ID>" },
  "checkedAt": "2026-01-15T09:30:00Z"
}
```

Values: `forge` ∈ `github | gitlab`; `host` = the real forge host (SSH alias resolved);
`project` = the repo path on the forge (`owner/name`, or `group/subgroup/name` on GitLab);
`tracker` ∈ `jira | linear | github-issues | gitlab-issues | none`; `trackerSite` = the
Jira site, when the tracker is Jira; each tool ∈ `gh | glab | acli | jira | linear | curl |
mcp | none`; `slack.jiraNotificationsDm` (optional) = the DM where this repo's Slack
workspace receives Jira notifications, filled in by SKILL.md step 2b.

- **Fresh** (profile exists, `checkedAt` less than 30 days old, no `--setup` argument):
  use it. Re-check only the forge CLI's auth (`gh auth status --hostname <host>` /
  `glab auth status --hostname <host>`, exit code is enough). If a source fails during the
  run, re-detect that source alone and update the profile.
- **Missing, stale, or `--setup` / "reconfigure"** → full detection below. With `--setup`,
  show the resulting profile and stop there unless a change request was also given.

## 3. Detect

**Forge CLI** (mandatory):

| Forge | Present | Authenticated for the host | Fix |
|-------|---------|----------------------------|-----|
| GitHub | `command -v gh` | `gh auth status --hostname <host>` (exit 0) | `brew install gh` · `gh auth login --hostname <host> --web` |
| GitLab | `command -v glab` | `glab auth status --hostname <host>` (exit 0) | `brew install glab` · `glab auth login --hostname <host> --web` |

(Install commands are the Homebrew ones; on another system point to the CLI's install
page.) No usable forge CLI → try the forge's MCP connector via ToolSearch as a degraded
fallback; if there is none either, stop after the Setup block: without the forge there is
nothing to diagnose.

**Tracker.** Take it from the profile. Otherwise infer it from the change request (body,
title, branch) and the repo:

- a Jira URL (`<site>.atlassian.net/browse/KEY-1` or another Jira host) → `jira`, and keep
  the site as `trackerSite`;
- a `linear.app/<team>/issue/KEY-1` URL → `linear`;
- a bare `KEY-1` key → ambiguous: whichever of Jira or Linear has a working tool and finds
  the key; if both or neither, ask once and save the answer;
- no external key but a forge issue referenced (`Closes #12`, closing or linked issues) →
  `github-issues` / `gitlab-issues` (the forge CLI covers it);
- nothing at all → `none` for now; detect again on the next change request of that repo.

**Tool per source** — CLI if installed and authenticated, else MCP connector if present,
else `none`:

| Source | CLI check (local) | Connector check | Fix to suggest |
|--------|-------------------|-----------------|----------------|
| Jira | `command -v acli && acli jira auth status`; or `command -v jira` (community jira-cli, see tracker-jira.md) | ToolSearch "atlassian jira" | `acli jira auth login --web`, or connect the Atlassian connector |
| Linear | `command -v linear` (check its `--help`); or `LINEAR_API_KEY` set in the environment → `curl` | ToolSearch "linear" | set `LINEAR_API_KEY` (Linear → Settings → API), or connect the Linear connector |
| Confluence | `acli confluence auth status` (reads a page by ID only, no search) | ToolSearch "confluence" | connect the Atlassian connector (search needs it) |
| Slack | — (no common read CLI) | ToolSearch "slack" | connect the Slack connector |
| Gmail | — | ToolSearch "gmail" | connect the Gmail connector |

A connector that is listed but answers "authentication required" counts as missing, with
"authenticate the <name> connector" as the fix. For Jira, also check that the CLI is logged
into the same site as `trackerSite` (a wrong site returns nothing or "not granted"); if
not, the fix is `acli jira auth switch`.

## 4. Save

No `CFG` (not inside a git repo) → nothing is saved; say "No git repo: profile not saved"
in one line.

Before the first write, make sure git ignores the file without touching any tracked file:
if it is not ignored yet, add it to `$common/info/exclude` (local to this clone, never
committed, shared by its worktrees). A profile stored in git's own dir needs nothing.

```bash
EXCLUDED=
if [ -n "$ROOT" ] && ! git -C "$ROOT" check-ignore -q .claude/pr-blockers.local.json; then
  mkdir -p "$common/info"
  echo '.claude/pr-blockers.local.json' >> "$common/info/exclude"
  EXCLUDED=", git-ignored via $common/info/exclude"
fi
```

Then write the profile with `checkedAt` = now (UTC), merging into the existing file so the
`slack` section is kept, and say in one line: "Profile saved to <path>" followed by
`$EXCLUDED` when it is set.

```bash
mkdir -p "$(dirname "$CFG")"; [ -f "$CFG" ] || echo '{}' > "$CFG"
jq --argjson p "$PROFILE_JSON" '. * $p' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
```

The Jira notifications DM, once discovered (SKILL.md step 2b), is saved to the same repo
profile, the same way:

```bash
jq --arg id "$DM_ID" '.slack.jiraNotificationsDm = $id' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
```

## 5. Setup block in the report

Only when something is missing, unauthenticated, or the profile was just created/updated.
One line per gap, with the exact command; suggest typing `! <command>` in Claude Code so it
runs in the session. Logins that open a browser (`--web`) work that way; a login that asks
interactive questions is better run in a separate terminal. Example:

```
### Setup
- glab not authenticated for gitlab.example.com → `glab auth login --hostname gitlab.example.com --web`
- Jira: no CLI, no connector → `acli jira auth login --web` (or connect the Atlassian connector)
- Profile saved to .claude/pr-blockers.local.json, git-ignored via .git/info/exclude (gitlab · jira · glab, mcp for Slack)
```

Each gap also appears under "Not verified" with what it leaves uncovered.
