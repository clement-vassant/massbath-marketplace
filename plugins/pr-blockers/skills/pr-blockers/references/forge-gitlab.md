# Forge: GitLab (`glab`)

Commands for SKILL.md steps 0–2 when the forge is GitLab (gitlab.com or self-hosted). Run
each in its own command and redirect long outputs to a scratchpad file. MRs are numbered
by their IID (`!42`).

## Host and project

- Inside the repo, `glab` picks the host from the git remote. Outside it, or for an MR URL
  from another project, pass `-R <host>/<group>/<name>` (the full URL is also accepted) to
  `glab mr` / `glab ci` commands, and `--hostname <host>` to `glab api`.
- In `glab api` paths, `:id` / `:fullpath` are replaced with the current repo's project.
  For another project, use its URL-encoded path: `projects/group%2Fsub%2Fname/...`.
- `glab api` has no `--jq` flag (unlike `glab mr view`): pipe into `jq`.

```bash
P=:id                                        # or the URL-encoded path of another project
MR=$(glab mr view -F json | jq .iid)         # when no argument: MR of the current branch
glab api user | jq -r .username              # current user
```

## Snapshot

```bash
glab mr view $MR -F json > mr.json           # the API's merge request object
jq '{iid, title, web_url, state, draft, author: .author.username, source_branch, target_branch,
     sha, detailed_merge_status, has_conflicts, blocking_discussions_resolved,
     reviewers: [.reviewers[].username], head_pipeline: .head_pipeline | {id, status, web_url},
     description, created_at, updated_at}' mr.json
```

If a field is missing from `glab mr view` output (older glab), read the same object from
the API: `glab api projects/$P/merge_requests/$MR`.

Approvals:

```bash
glab api projects/$P/merge_requests/$MR/approvals | jq '{approved, approvals_required, approvals_left, approved_by: [.approved_by[].user.username]}'
glab api projects/$P/merge_requests/$MR/approval_state | jq '.rules[] | {name, approvals_required, approved, eligible: [.eligible_approvers[].username], approved_by: [.approved_by[].username]}'
```

(`approval_state` and approval rules are a paid-tier feature; on the free tier only
`/approvals` answers. `glab mr approvers $MR` lists eligible approvers.)

Discussions (review threads and comments):

```bash
glab api projects/$P/merge_requests/$MR/discussions --paginate | jq '[.[] | select(.notes[0].system | not) | {
  id, resolvable: .notes[0].resolvable, resolved: (.notes | map(select(.resolvable)) | all(.resolved)),
  path: .notes[0].position.new_path,
  notes: [.notes[] | {author: .author.username, created_at, body}]}]'
```

`glab mr note list $MR -F json --state unresolved` gives the same data, but is marked
experimental: prefer the API. System notes (`"system": true`) carry the history — "approved
this merge request", "added N commits", "requested review from" — useful for dating an
approval against the last push.

CI:

```bash
glab ci get --merge-request=$MR --status=failed --with-job-details -F json   # failed jobs of the MR's head pipeline
glab api "projects/$P/pipelines/<pipeline-id>/jobs?scope[]=failed" | jq '.[] | {id, name, stage, status, failure_reason, web_url}'
glab api projects/$P/jobs/<job-id>/trace > job.log                            # full log, read the end
```

## Reading the fields

- **Reviews**: `reviewers` who have not approved nor commented since being requested are
  silent reviewers. A resolvable discussion not resolved is an open thread; who spoke last
  = author of its last note. `blocking_discussions_resolved == false` means the project
  requires resolved threads before merging (merge blocker).
- **Approvals**: `approvals_left > 0` → missing approval; with rules, say which rule and its
  eligible approvers.
- **Invalidated approval**: if the project resets approvals on push, the approval simply
  disappears; spot it from the system notes (approved, then commits added, no approval
  since) → re-approval to request from that reviewer.
- **Mergeability**: `detailed_merge_status` — `mergeable` OK; `conflict` (also
  `has_conflicts`) → conflict; `need_rebase` → branch behind the target;
  `not_approved`, `discussions_not_resolved`, `ci_must_pass`, `ci_still_running`,
  `draft_status`, `blocked_status` (blocked by another MR) explain the rest.
  `checking` / `unchecked` = not computed yet: re-read before concluding.
- **CI**: `head_pipeline.status` (`failed`, `running`, `pending`, `manual`…). A failed job's
  `failure_reason` (`runner_system_failure`, `stuck_or_timeout_failure`,
  `script_failure`…) helps tell an infrastructure failure from a change failure.
- **Stacked MR**: `target_branch` ≠ default branch
  (`glab repo view -F json | jq -r .default_branch`) →
  `glab mr list --source-branch=<target_branch> -F json` (open MRs by default); open →
  blocker. GitLab also has explicit MR dependencies (`blocked_status`): see
  `glab api projects/$P/merge_requests/$MR/blocks` (check it exists on the instance).
- Bot authors: usernames with `bot` in them (`project_<id>_bot…`, `ghost`, renovate…).
- **Diff** (reference state, step 2): `glab mr diff $MR --raw > mr.diff`, then read only
  the files that carry the behavior.

## GitLab issues as the tracker

When the profile's tracker is `gitlab-issues`: `glab mr issues $MR` lists the issues the MR
closes, else a `#<n>` in the description.

```bash
glab issue view <n> -F json                         # body, state, assignees, labels
glab issue view <n> --comments                      # with comments (text)
glab api projects/$P/issues/<n>/notes --paginate | jq '.[] | select(.system | not) | {author: .author.username, created_at, body}'
glab api projects/$P/issues/<n>/links | jq '.[] | {iid, title, state, link_type, assignees: [.assignees[].username]}'
glab issue list --search "<keywords>" --all -O json # step 3 search (here -F is --output-format, not JSON)
```

Linked issues with `link_type == "is_blocked_by"` that are still open are dependencies.

## Mentions in drafts

`@username` in an MR or issue comment notifies the person.
