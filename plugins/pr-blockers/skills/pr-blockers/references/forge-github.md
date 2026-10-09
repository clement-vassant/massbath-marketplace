# Forge: GitHub (`gh`)

Commands for SKILL.md steps 0–2 when the forge is GitHub (github.com or GitHub
Enterprise). Run each in its own command and redirect long outputs to a scratchpad file.

## Change request and user

```bash
PR=$(gh pr view --json number -q .number)       # when no argument: PR of the current branch
gh api user -q .login                           # current user
```

A PR URL from another repo → add `--repo <owner>/<name>` (or `<host>/<owner>/<name>` on
GitHub Enterprise) to every `gh pr` command, and `--hostname <host>` to `gh api` on
Enterprise.

## Snapshot

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner); OWNER=${REPO%/*}; NAME=${REPO#*/}

gh pr view $PR --json number,title,url,state,isDraft,author,baseRefName,headRefName,headRefOid,body,\
mergeable,mergeStateStatus,reviewDecision,reviewRequests,latestReviews,closingIssuesReferences,createdAt,updatedAt
gh pr checks $PR --json name,state,bucket,link,completedAt,workflow   # CI: bucket = pass|fail|pending|skipping|cancel
gh api repos/$REPO/issues/$PR/comments --paginate --jq '.[] | {user: .user.login, created_at, body}'
gh api repos/$REPO/pulls/$PR/reviews  --paginate --jq '.[] | {user: .user.login, state, commit_id, submitted_at, body}'
gh api graphql -f query="{ repository(owner:\"$OWNER\", name:\"$NAME\") { pullRequest(number:$PR) {
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
  `/actions/runs/<run-id>/job/<job-id>`; then `gh run view <run-id> --log-failed` (or
  `--job <job-id> --log-failed`), redirected to a file, and read the end.
- **Stacked PR**: `baseRefName` ≠ default branch
  (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`) →
  `gh pr list --head <baseRefName> --json number,state,url`; open → blocker.
- Bot authors: login ending in `[bot]`.
- **Diff** (reference state, step 2): `gh pr diff $PR --name-only` first, then
  `gh pr diff $PR` redirected to a file, reading only the files that carry the behavior.

## GitHub issues as the tracker

When the profile's tracker is `github-issues`: the PR's `closingIssuesReferences` gives the
ticket(s), else a `#<n>` in the body.

```bash
gh issue view <n> --json number,title,state,body,author,assignees,labels,parent,blockedBy,subIssues,comments,url
gh issue list --search "<keywords>" --state all --json number,title,state,url --limit 20   # step 3 search
```

`blockedBy` items that are still open are dependencies (blockers), with their assignee as
the person to chase.

## Mentions in drafts

`@login` in a PR or issue comment notifies the person.
