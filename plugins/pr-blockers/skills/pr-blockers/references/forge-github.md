# Forge: GitHub (`gh`)

Commands for SKILL.md steps 0–2 when the forge is GitHub (github.com or GitHub
Enterprise). Run each in its own Bash call and redirect long outputs to `"$SCRATCH"/…` (the
scratchpad, SKILL.md "Tools"). Bash calls don't share variables: start each call with the
assignments it uses (`SCRATCH`, `PR`, `HOST`, `REPO`…), as literal values.

## Repo, change request and user

The repo comes from the URL argument when there is one, never from the cwd (setup.md § 1):
`https://<host>/<owner>/<name>/pull/<n>` → `HOST=<host> REPO=<owner>/<name> PR=<n>`. Every
`gh pr` / `gh run` / `gh issue` command then gets `-R "$HOST/$REPO"` (`gh repo view` takes
it as its argument: `gh repo view "$HOST/$REPO"`), and every `gh api` call (REST and
GraphQL) gets `--hostname "$HOST"` (needed on GitHub Enterprise, harmless on github.com).
Without a URL, take them from the current repo:

```bash
HOST=github.com     # or the GitHub Enterprise host from setup.md § 1
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # no URL argument only
PR=$(gh pr view --json number -q .number)                     # no argument at all: PR of the current branch
gh api --hostname "$HOST" user -q .login                      # current user
```

## Snapshot

```bash
SCRATCH=/path/to/scratchpad HOST=github.com REPO=acme/storefront PR=1234   # literal values, see above
OWNER=${REPO%/*}; NAME=${REPO#*/}

gh pr view "$PR" -R "$HOST/$REPO" --json number,title,url,state,isDraft,author,baseRefName,headRefName,headRefOid,body,\
mergeable,mergeStateStatus,reviewDecision,reviewRequests,latestReviews,closingIssuesReferences,createdAt,updatedAt
gh pr checks "$PR" -R "$HOST/$REPO" --json name,state,bucket,link,completedAt,workflow   # CI: bucket = pass|fail|pending|skipping|cancel
gh api --hostname "$HOST" "repos/$REPO/issues/$PR/comments" --paginate \
  --jq '[.[] | {user: .user.login, created_at, body}]' | jq -s 'add' > "$SCRATCH"/comments.json
gh api --hostname "$HOST" "repos/$REPO/pulls/$PR/reviews" --paginate \
  --jq '[.[] | {user: .user.login, state, commit_id, submitted_at, body}]' | jq -s 'add' > "$SCRATCH"/reviews.json
gh api --hostname "$HOST" graphql -f query="{ repository(owner:\"$OWNER\", name:\"$NAME\") { pullRequest(number:$PR) {
  reviewThreads(first:100) { nodes { isResolved isOutdated path
    comments(first:30) { nodes { author { login } createdAt body url } } } } } } }"
gh api --hostname "$HOST" "repos/$REPO/issues/$PR/timeline" --paginate \
  --jq '[.[] | select(.event=="review_requested") | {at: .created_at, reviewer: (.requested_reviewer.login // .requested_team.slug)}]' \
  | jq -s 'add' > "$SCRATCH"/review-requests.json   # since when each review is requested
```

`--paginate --jq '[…]'` prints one array per page; `jq -s 'add'` merges them into one
array, so the saved files read with `jq '.[]'`. Never `--jq '.[] | {…}'` into a file: that
is JSON Lines, and a later `jq '.[]'` on it silently iterates field values instead of
objects. Latest review per reviewer:
`jq 'group_by(.user) | map(max_by(.submitted_at))' "$SCRATCH"/reviews.json`.
`reviewThreads` is not a valid field of `gh pr view --json`: go through GraphQL.
`gh pr checks` exits with code 8 when checks are pending: that is not an error.

## Reading the fields

- **Reviews**: `reviewRequests` = requested, not yet responded. `CHANGES_REQUESTED` in
  `latestReviews` is still active until that reviewer approves or the review is dismissed.
  `mergeStateStatus` `CLEAN` or `HAS_HOOKS` → the pending requests are not required: list
  them as optional ("reviewers requested, not required"), not as merge blockers. Don't
  query branch protection to find out: it needs admin rights.
- **Review bodies**: reservations usually sit in the REST reviews' `body` (an `APPROVED`
  with "but before enabling…"), not only in threads: read them all.
- **Invalidated approval**: judge each reviewer by their **latest** review only (REST
  reviews, last `submitted_at` per `user`). Latest is `DISMISSED`, or `APPROVED` with a
  `commit_id` that is not `headRefOid` while `reviewDecision` ≠ `APPROVED` → re-approval to
  request from that reviewer. Take `commit_id` from the REST reviews call:
  `latestReviews[].commit.oid` comes back empty from `gh pr view --json`. An older
  dismissed review followed by an approval on head is not a re-approval to ask for.
- **Conflicts**: `mergeable == CONFLICTING`, or `mergeStateStatus` = `DIRTY` (conflict) or
  `BEHIND` (branch must be updated). `BLOCKED` = a required review or check is missing.
- **Dependency PRs** named in the body ("depends on #123", a PR URL): extract every `#\d+`
  and PR URL, then `gh pr view <n> -R "$HOST/$REPO" --json number,state,title,url` (a URL
  from another repo: its own `-R`); an issue number answers "not found" as a PR, skip it.
  Open dependency → blocker.
- **CI log** (failure vs infrastructure): the check's `link` contains
  `/actions/runs/<run-id>/job/<job-id>`; then `gh run view <run-id> -R "$HOST/$REPO" --log-failed` (or
  `--job <job-id> --log-failed`), redirected to `"$SCRATCH"/ci.log`, and read the end.
- **Stacked PR**: `baseRefName` ≠ default branch
  (`gh repo view "$HOST/$REPO" --json defaultBranchRef -q .defaultBranchRef.name`) →
  `gh pr list -R "$HOST/$REPO" --head <baseRefName> --json number,state,url`; open → blocker.
- Bot authors: login ending in `[bot]`.
- **Diff** (reference state, step 2): `gh pr diff "$PR" -R "$HOST/$REPO" --name-only` first, then
  `gh pr diff "$PR" -R "$HOST/$REPO" > "$SCRATCH"/pr.diff`, reading only the files that
  carry the behavior.

## GitHub issues as the tracker

When the profile's tracker is `github-issues`: the PR's `closingIssuesReferences` gives the
ticket(s), else a `#<n>` in the body.

```bash
gh issue view <n> -R "$HOST/$REPO" --json number,title,state,body,author,assignees,labels,parent,blockedBy,subIssues,comments,url
gh issue list -R "$HOST/$REPO" --search "<keywords>" --state all --json number,title,state,url --limit 20   # step 3 search
```

`blockedBy` items that are still open are dependencies (blockers), with their assignee as
the person to chase. An older gh answers `Unknown JSON field` for `parent`, `blockedBy` or
`subIssues`: rerun without those fields, and say under "Not verified" that issue
dependencies were not checked.

## Mentions in drafts

`@login` in a PR or issue comment notifies the person.
