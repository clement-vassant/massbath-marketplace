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
HOST=github.com REPO=acme/storefront PR=1234   # literal values, see above
OWNER=${REPO%/*}; NAME=${REPO#*/}

gh pr view "$PR" -R "$HOST/$REPO" --json number,title,url,state,isDraft,author,baseRefName,headRefName,headRefOid,body,\
mergeable,mergeStateStatus,reviewDecision,reviewRequests,latestReviews,closingIssuesReferences,createdAt,updatedAt
gh pr checks "$PR" -R "$HOST/$REPO" --json name,state,bucket,link,completedAt,workflow   # CI: bucket = pass|fail|pending|skipping|cancel
gh api --hostname "$HOST" "repos/$REPO/issues/$PR/comments" --paginate --jq '.[] | {user: .user.login, created_at, body}'
gh api --hostname "$HOST" "repos/$REPO/pulls/$PR/reviews"  --paginate --jq '.[] | {user: .user.login, state, commit_id, submitted_at, body}'
gh api --hostname "$HOST" graphql -f query="{ repository(owner:\"$OWNER\", name:\"$NAME\") { pullRequest(number:$PR) {
  reviewThreads(first:100) { nodes { isResolved isOutdated path
    comments(first:30) { nodes { author { login } createdAt body url } } } } } } }"
```

`reviewThreads` is not a valid field of `gh pr view --json`: go through GraphQL.
`gh pr checks` exits with code 8 when checks are pending: that is not an error.

## Reading the fields

- **Reviews**: `reviewRequests` = requested, not yet responded. `CHANGES_REQUESTED` in
  `latestReviews` is still active until that reviewer approves or the review is dismissed.
- **Invalidated approval**: a `DISMISSED` review, or an `APPROVED` review whose
  `commit_id` is not `headRefOid` while `reviewDecision` ≠ `APPROVED` → re-approval to
  request from that reviewer.
- **Conflicts**: `mergeable == CONFLICTING`, or `mergeStateStatus` = `DIRTY` (conflict) or
  `BEHIND` (branch must be updated). `BLOCKED` = a required review or check is missing.
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
