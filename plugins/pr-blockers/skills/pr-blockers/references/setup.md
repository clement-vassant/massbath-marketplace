# Setup: per-repo self-configuration

Goal: for the repo at hand, know which forge it lives on, which tracker its tickets live
in, and which tool reaches each source — and say exactly what is missing. People work on
repos that run differently (one on GitHub with Linear, another on a self-hosted GitLab with
Jira), so this is decided per repo, never globally.

Never install anything, never log in, never change a CLI's config on the user's behalf:
those are the user's calls. Detection and preflight only read (`--version`, `auth status`,
`ssh -G`, ToolSearch, a `user` API call, one minimal read per source). The only files
written are the repo profile below and, once, a line in the clone's local `info/exclude`
so git ignores it. Never print a token to find out whether one exists (`gh auth token`,
`glab config get token`, `echo $LINEAR_API_KEY`): test `[ -n "${LINEAR_API_KEY:-}" ]` or
make the API call.

## 1. Identify the repo and the forge

A PR/MR URL given as argument defines the repo; the cwd only matters if it is a clone of
that same repo.

```bash
git remote get-url origin 2>/dev/null   # the cwd's repo, if any
```

Normalize the URL argument and the origin to `host` and `project` (the repo path), both
kept in the profile:

- `git@host:group/sub/name.git`, `ssh://git@host:2222/group/name.git`,
  `https://host/group/name(.git)` → host + path without `.git`. GitLab paths can have
  nested groups: keep the whole path.
- An SSH host alias (`git@work-gh:org/repo.git`, defined in `~/.ssh/config`) is not the
  real host: resolve it with `ssh -G <alias> | awk '/^hostname /{print $2}'` (local, no
  connection).
- From a URL argument: `https://<host>/<project>/pull/<n>` → GitHub,
  `https://<host>/<project>/-/merge_requests/<n>` → GitLab.

Which repo, and which profile:

- No URL argument → the origin defines the repo.
- URL argument, origin normalizes to the same host + project → that repo; its profile
  applies (§ 2).
- URL argument, origin differs (or no git repo) → run on the URL's repo without a profile:
  do not read, create or overwrite the cwd's profile, it belongs to another repo. Say it in
  one line ("Profile not used: the current directory is <cwd project>, not <URL project>;
  rerun from a clone of it to save one"). Every forge command then targets the URL's repo
  explicitly (see the forge reference file).

Forge from the host:

- `github.com` → GitHub. `gitlab.com` → GitLab.
- Any other host: the GitHub auth test of § 3 succeeds → GitHub Enterprise; the GitLab
  one succeeds → self-hosted GitLab; a host name
  containing `gitlab` or `github` is a strong hint. Still unknown → ask the user, and save
  the answer.

## 2. Read the profile

One profile per repo, personal and never committed:
`<main checkout>/.claude/pr-blockers.local.json` (the `.local` suffix is Claude Code's
convention for personal files). Two repos can belong to two different companies — another
forge, tracker, Jira site and Slack workspace — so nothing is shared between repos. All
worktrees of a repo share the main checkout's profile.

Bash calls don't share variables: each block below recomputes them. Every block that reads
or writes the profile starts with the same `common=` / `case` lines (run only when § 1
says the profile applies). Reading it:

```bash
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=
case "$common" in
  "")     ROOT=; CFG= ;;                                                  # not inside a git repo: no profile
  */.git) ROOT=$(dirname "$common"); CFG="$ROOT/.claude/pr-blockers.local.json" ;;
  *)      ROOT=; CFG="$common/pr-blockers.local.json" ;;                  # bare repo or unusual layout: in git's own dir
esac
[ -n "$CFG" ] && jq . "$CFG" 2>/dev/null
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
    "gmail": "none"
  },
  "gmailReason": "connected mailbox is a personal one",
  "gmailOutOfScopeDomain": "personal.example",
  "slack": { "jiraNotificationsDm": "<DM channel ID>" },
  "checkedAt": "2026-01-15T09:30:00Z"
}
```

Values: `forge` ∈ `github | gitlab`; `host` = the real forge host (SSH alias resolved);
`project` = the repo path on the forge (`owner/name`, or `group/subgroup/name` on GitLab);
`tracker` ∈ `jira | linear | github-issues | gitlab-issues | none`; `trackerSite` = the
Jira site, when the tracker is Jira; each tool ∈ `gh | glab | acli | jira | linear | curl |
mcp | none`; `slack.jiraNotificationsDm` (optional) = the DM where this repo's Slack
workspace receives Jira notifications, filled in by SKILL.md step 2b; `gmailReason` /
`gmailOutOfScopeDomain` (optional) = why the connected Gmail is not used, and the domain of
that mailbox (§ 3).

The profile holds non-sensitive configuration only: tool names, host, project, site,
channel ID. Never a token, a message or ticket excerpt, a person's name, or an email
address: for the wrong-mailbox case the domain is enough to notice that the connector now
points to another account (personal ↔ work), while the local part identifies a person for
nothing; a switch within the same domain is caught by `--setup`. An older profile's
`gmailAccount` is dropped at the next save (§ 4). Transient probe outcomes (§ 5: OK, not
reachable) change from run to run and are not saved. A Gmail **out of scope** result is
configuration and IS saved (`"gmail": "none"` + `gmailReason` + `gmailOutOfScopeDomain`).
A profile with `"gmail": "mcp"` still gets the mailbox check every run (it is its preflight
probe); found out of scope → update the profile that way.

- **Fresh** (profile exists, `checkedAt` less than 30 days old, no `--setup` argument):
  use it, then run the preflight (§ 5). Re-detect, cheaply, every source recorded as
  `none` (`command -v`, ToolSearch, as in § 3): one that became available is written to
  the profile (§ 4) and probed. Exception: a Gmail recorded `none` with a
  `gmailOutOfScopeDomain` (wrong mailbox, § 3) is never searched; its probe only checks
  whether the connected mailbox's domain changed. If a source fails during the run,
  re-detect that source alone and update the profile if its tool changed. Nothing changed
  → no save; the Access block gets the "Profile used" line (§ 6).
- **Missing, stale, or `--setup` / "reconfigure"** → full detection below. With `--setup`,
  show the resulting profile and stop there unless a change request was also given.

## 3. Detect

**Forge CLI** (mandatory):

| Forge | Present | Authenticated for the host | Fix |
|-------|---------|----------------------------|-----|
| GitHub | `command -v gh` | `gh api --hostname <host> user -q .login` (exit 0 and a login) | `brew install gh` · `gh auth login --hostname <host> --web` |
| GitLab | `command -v glab` | `glab api --hostname <host> user \| jq -r .username` (exit 0 and a username) | `brew install glab` · `glab auth login --hostname <host> --web` |

Test auth with a real `user` call, not `auth status`: `gh auth status` exits 1 as soon as
any keyring account for that host has a bad token, even when the active one works — a false
"forge missing". Run `gh auth status --hostname <host>` / `glab auth status --hostname
<host>` only to word the diagnostic once the `user` call has failed.

(Install commands are the Homebrew ones; on another system point to the CLI's install
page.) No usable forge CLI → try the forge's MCP connector via ToolSearch as a degraded
fallback; if there is none either, stop after the Access block: without the forge there is
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
else `none` (Confluence is the exception, see below the table):

| Source | CLI check (local) | Connector check | Fix to suggest |
|--------|-------------------|-----------------|----------------|
| Jira | `command -v acli && acli jira auth status`; or `command -v jira` (community jira-cli, see tracker-jira.md) | ToolSearch "atlassian jira" | `acli jira auth login --web`, or connect the Atlassian connector |
| Linear | `command -v linear` (check its `--help`); or `[ -n "${LINEAR_API_KEY:-}" ]` (set; never printed) → `curl` | ToolSearch "linear" | set `LINEAR_API_KEY` (Linear → Settings → API), or connect the Linear connector |
| Confluence | `acli confluence auth status` (reads a page by ID only, no search) | ToolSearch "confluence" | connect the Atlassian connector (search needs it) |
| Slack | — (no common read CLI) | ToolSearch "slack" | connect the Slack connector |
| Gmail | — | ToolSearch "gmail", then the mailbox check below | connect the Gmail connector |

Confluence is the exception to "CLI first": the step 3 Confluence search needs CQL, which
only the Atlassian connector offers. Whenever the connector is present, record `mcp` for
Confluence and use acli at most to read a page already linked (by its ID). With acli alone,
record `acli`: linked pages are read, and "Confluence search" goes under "Not verified".

**Gmail mailbox check.** A connected Gmail can be the wrong mailbox (another employer's, a
personal one). Even a metadata-only search returns sender and recipient addresses into the
context: unavoidable with the connector, so keep it to the minimum. Search
`in:sent from:me`, `pageSize: 1`, metadata only, and read only the account's domain: the
`authuser` in the result's view URL, or the SENT-labelled message's sender. Rely on the
SENT label, not on the thread's first message: it can be an incoming one. Every other
address in the result (recipients, third parties) is never quoted, never stored.
Not the mailbox where the project's exchanges arrive → record `"gmail": "none"`,
`"gmailReason": "<why, without the address>"` and `"gmailOutOfScopeDomain": "<domain after
the @>"`, so the next runs don't search it. The address itself is neither stored nor quoted
in the report ("connected mailbox is a personal one" is enough).

**Atlassian connectors.** Two can be loaded at once: one with direct tools
(`getJiraIssue`, `searchConfluenceUsingCql`…), another with `discover` / `executeRead`.
Either works; for Confluence, prefer the one that exposes CQL search.

A connector that is listed but answers "authentication required" counts as missing, with
"authenticate the <name> connector" as the fix. For Jira, also check that the CLI is logged
into the same site as `trackerSite` (a wrong site returns nothing or "not granted"); if
not, the fix is `acli jira auth switch`.

## 4. Save

No profile for this run (not inside a git repo, or the cwd is another repo than the URL's,
§ 1) → nothing is saved; say so in one line ("No git repo: profile not saved", or the
§ 1 line).

One self-contained block (Bash calls don't share variables: it recomputes the paths) does
both writes. First it makes sure git ignores the file without touching any tracked file:
if it is not ignored yet, it adds it to `$common/info/exclude` (local to this clone, never
committed, shared by its worktrees; a profile stored in git's own dir needs nothing). Then
it writes the profile, merging into the existing file so the `slack` section is kept. Put
the detected profile in `PROFILE_JSON` as a literal (the block sets `checkedAt` itself),
and report the line it prints ("Profile saved to <path>[, git-ignored via <path>]"; no
suffix means the exclude line already existed → report "already git-ignored").

Save once per run. The tracker is not Jira, or the profile already has the Slack DM →
save right after the preflight (§ 5), so an out-of-scope Gmail lands in it too. Only when
step 2b has to discover the DM → save once at the end of 2b, with
`"slack":{"jiraNotificationsDm":"<ID>"}` already in `PROFILE_JSON`.

```bash
PROFILE_JSON='{"forge":"gitlab","host":"gitlab.example.com","project":"team/backend","tracker":"jira","tools":{"forge":"glab"}}'
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=
case "$common" in
  "")     ROOT=; CFG= ;;
  */.git) ROOT=$(dirname "$common"); CFG="$ROOT/.claude/pr-blockers.local.json" ;;
  *)      ROOT=; CFG="$common/pr-blockers.local.json" ;;
esac
if [ -n "$CFG" ]; then
  EXCLUDED=
  if [ -n "$ROOT" ] && ! git -C "$ROOT" check-ignore -q .claude/pr-blockers.local.json; then
    EX="$common/info/exclude"; mkdir -p "$common/info"
    if [ -s "$EX" ] && [ "$(tail -c1 "$EX")" ]; then echo >> "$EX"; fi   # no trailing newline: add one first
    echo '.claude/pr-blockers.local.json' >> "$EX"
    EXCLUDED=", git-ignored via $EX"
  fi
  mkdir -p "$(dirname "$CFG")"; [ -f "$CFG" ] || echo '{}' > "$CFG"
  jq --argjson p "$PROFILE_JSON" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. * $p | del(.gmailAccount) | .checkedAt = $now' \
    "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG" && echo "Profile saved to $CFG$EXCLUDED"
fi
```

If the profile was already saved earlier in the run, the Jira notifications DM, once
discovered (SKILL.md step 2b), is added to it with the same path lines and the DM ID as a
literal:

```bash
DM_ID='<DM channel ID>'
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=
case "$common" in
  "")     CFG= ;;
  */.git) CFG="$(dirname "$common")/.claude/pr-blockers.local.json" ;;
  *)      CFG="$common/pr-blockers.local.json" ;;
esac
if [ -n "$CFG" ] && [ -f "$CFG" ]; then
  jq --arg id "$DM_ID" '.slack.jiraNotificationsDm = $id' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG" \
    && echo "Jira notifications DM saved to $CFG"
fi
```

## 5. Preflight: prove access

A tool that is installed and "logged in" can still be on the wrong account, site or
mailbox, lack a scope, or lack the organization's SSO grant. Such a source answers nothing,
and nothing would pass for "no answer was given". So every run, right after the profile is
read or detected and before SKILL.md step 1, each source gets **one minimal read** that
proves the skill can see what this change request needs.

- Run the probes **in parallel** (one message, one Bash or connector call each): forge,
  Slack, Confluence, Gmail. Slack and Confluence test access, not content: any minimal
  query (the repo name, limit 1) will do — don't wait for the ticket key. The tracker probe
  needs the key: key already known (URL, branch name) → it joins the same parallel batch;
  else right after the forge probe (or step 1) gives it, always before step 2.
- **Transient** failure (timeout, connection reset, HTTP 5xx, 429 / rate limit) → retry
  once, then declare it. Auth, permission, not-found errors are not retried: they say what
  is wrong.
- Each source ends as **OK**, **not reachable** (exact cause from the error, and the fix),
  or **out of scope** (Gmail on another mailbox). An empty search result is OK: the probe
  tests access, not content.
- Only OK sources are used and get a sub-agent; the others go under "Not verified" with the
  reason. OK / not reachable are not saved; Gmail out of scope is (§ 2).
- Probes print only identifiers and states: never a token, never `-v` / `--verbose` /
  `GH_DEBUG` / `set -x` (they print the auth header).

### Forge (mandatory: failure → stop after the Access block)

GitHub: the `user` call, then the PR itself, a few fields only (the title and branch often
hold the ticket key).

```bash
HOST=github.com REPO=acme/storefront PR=1234   # literal values (forge-github.md)
gh api --hostname "$HOST" user -q .login
gh pr view "$PR" -R "$HOST/$REPO" --json number,state,title,headRefName
```

No argument at all: `gh pr view --json number,state,title,headRefName` (the current
branch's PR; `-R` would require a number).

| Error (stderr) | Cause | Fix |
|----------------|-------|-----|
| `HTTP 401`, `Bad credentials`, not logged in | token missing or revoked for this host | `gh auth login --hostname <host> --web` |
| `could not resolve host`, connection refused | wrong host, VPN off | check the host from setup.md § 1; connect the VPN |
| `Could not resolve to a Repository`, `HTTP 404` on the repo | repo invisible to this account: other account active, missing scope, typo | `gh auth switch --hostname <host>`; `gh auth refresh -h <host> -s repo` |
| `SAML enforcement`, `SSO`, `HTTP 403` | token not authorized for the organization | open the URL from `gh api --hostname "$HOST" -i "repos/$REPO" 2>&1 \| grep -i '^x-github-sso'` and authorize, then rerun |
| `Could not resolve to a PullRequest`, `no pull requests found for branch` | wrong number, or no PR for the current branch | ask for the PR number or URL |

GitLab: the same two reads through the API (its errors carry the HTTP status).

```bash
HOST=gitlab.example.com P=team%2Fbackend MR=42   # literal values (forge-gitlab.md)
glab api --hostname "$HOST" user | jq -r .username
glab api --hostname "$HOST" "projects/$P/merge_requests/$MR" | jq '{iid, state, title, source_branch}'
```

No argument at all: `glab mr view -F json | jq '{iid, state, title, source_branch}'`.

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | token missing, expired or revoked | `glab auth login --hostname <host> --web` |
| `403 Forbidden`, `insufficient_scope` | token without `read_api` | log in again, or a token with `read_api` |
| `404 Project Not Found` (check with `glab api --hostname "$HOST" "projects/$P" \| jq .id`) | private project invisible to this account, or wrong path | log in with the account that has access; check the path |
| `404 Not found` on the MR, project OK | wrong MR number | ask for the MR number or URL |

### Tracker: read the ticket once

The probe IS the step 2 ticket read: one call on the ticket, not two. Ask it for the fields
step 2 needs (acli: `--fields` with step 2's list instead of `key,status`; connector:
`getJiraIssue` with those fields), save the output to `$SCRATCH`, and step 2 reuses that
file instead of reading the ticket again. Same for Linear and forge issues.

Jira with acli: the account must be on the profile's `trackerSite`, then one view.

```bash
acli jira auth status                                       # site and account
acli jira workitem view SHOP-1 --fields 'summary,status,assignee,parent,issuelinks,description,updated' --json > "$SCRATCH"/ticket.json   # literal key; step 2 reuses this file
```

- Not logged in → `acli jira auth login --web`. Logged into another site → `acli jira auth
  switch` (do not read a ticket on the wrong site: it answers "not found").
- The view fails with "does not exist or you do not have permission" (Jira gives the same
  answer for both) → `acli jira project view --key SHOP --json`: project fails too → no
  access to the project on that site (ask a Jira admin, or wrong site); project OK →
  the ticket does not exist (wrong key).

Jira with the connector: `getAccessibleAtlassianResources`, keep the cloudId whose `url`
is the `trackerSite` (none → "connector not granted on <site>": reconnect it with an account
that has access), then `getJiraIssue` on the key with step 2's fields. "Authentication
required" → unauthenticated; 404 → missing ticket or no permission (search the project with
`searchJiraIssuesUsingJql`, `project = SHOP`, 1 result, to tell them apart).

Community `jira` CLI: `jira me` (auth), then a plain view of the key (check `--help`).

Linear: with `curl`, one query on the key (the `linear_q` function from tracker-linear.md,
defined in the same Bash call; the key stays in the environment):

```bash
linear_q 'query($id: String!) { issue(id: $id) { identifier state { name } } }' '{"id": "SHOP-120"}' | jq -c '{data, errors: [.errors[]?.message]}'
```

`Authentication required` / HTTP 401 → key invalid or revoked (create a new one: Linear →
Settings → API, and export it); `Entity not found` → wrong key, or an issue outside the
key's workspace. With a `linear` CLI or the connector: one view of the key, same reading.

Forge issues as the tracker: covered by the forge probe; read the issue once
(`gh issue view <n> --json number,state` / `glab api … /issues/<n>`).

### Slack, Confluence, Gmail: one read each

| Source | Probe | Not reachable when |
|--------|-------|--------------------|
| Slack | `slack_search_public_and_private`, query = the repo name (or the key if known), 1 result, concise. Profile has a `jiraNotificationsDm` → also check it with the cheapest call (`slack_read_channel`, limit 1); access is already proven by the search, this only checks the ID. Limit 1 still returns one message's content (often a long tracking URL): acceptable, but never copy it, nor any token. Option, if the connector takes `oldest`/`latest`: a window that returns 0 messages proves the ID without content | `not_authed`, `invalid_auth`, "authentication required", `missing_scope`. `channel_not_found` on the DM → drop it, step 2b rediscovers it |
| Confluence (connector) | `searchConfluenceUsingCql`, `text ~ "<repo name>"`, limit 1, with a cloudId from `getAccessibleAtlassianResources` | authentication required, site not in `getAccessibleAtlassianResources` |
| Confluence (acli only) | `acli confluence auth status` | not logged in, other site |
| Gmail | the mailbox check of § 3 (`in:sent from:me`, `pageSize: 1`, metadata only, only the account's domain read, no other address quoted or stored), every run even when the profile says `mcp` | authentication required; another mailbox → **out of scope**, not "not reachable": saved (§ 2) |

## 6. Access block in the report

Always at the top of the report, right under the title: the user sees what the diagnosis
could rely on. One line when everything passed; one line per source that did not, with the
cause and the exact fix; one line when the profile was saved. Suggest typing `! <command>`
in Claude Code so the fix runs in the session. Logins that open a browser (`--web`) work
that way; one that asks interactive questions is better run in a separate terminal.

Everything passed:

```
### Access
OK: GitHub (gh, acme/storefront #1234) · Jira (acli, example.atlassian.net, SHOP-1) · Slack · Confluence (connectors)
```

With gaps:

```
### Access
- OK: GitLab (glab, gitlab.example.com) · Slack (connector)
- Linear: not reachable, `LINEAR_API_KEY` rejected (401) → create a key (Linear → Settings → API) and export it
- Confluence: no connector → connect the Atlassian connector · Gmail: out of scope (connected mailbox is a personal one)
- Profile saved to .claude/pr-blockers.local.json, git-ignored via .git/info/exclude (gitlab · linear · glab, curl, mcp for Slack)
```

When the exclude line already existed (the save printed no suffix), the last line reads
`Profile saved to .claude/pr-blockers.local.json, already git-ignored (…)`.

Fresh profile, nothing changed (§ 2: no save, so no save output) → the line reads
`Profile used: .claude/pr-blockers.local.json (fresh, <checkedAt date>), already git-ignored`.
Confirm "already git-ignored" first; if it is not, this block runs the save block's exclude
step (the one allowed write) and the line ends `, git-ignored via <path>` instead:

```bash
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=
case "$common" in
  */.git) ROOT=$(dirname "$common") ;;
  *)      ROOT= ;;                       # profile in git's own dir: never tracked, nothing to do
esac
if [ -n "$ROOT" ]; then
  if git -C "$ROOT" check-ignore -q .claude/pr-blockers.local.json; then
    echo "already git-ignored"
  else
    EX="$common/info/exclude"; mkdir -p "$common/info"
    if [ -s "$EX" ] && [ "$(tail -c1 "$EX")" ]; then echo >> "$EX"; fi
    echo '.claude/pr-blockers.local.json' >> "$EX"
    echo "git-ignored via $EX"
  fi
fi
```

Each source not OK also appears under "Not verified" with what it leaves uncovered.
