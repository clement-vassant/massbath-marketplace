# Forge: GitLab (`glab`)

Commands for SKILL.md steps 0–2 when the forge is GitLab (gitlab.com or self-hosted). Run
each in its own Bash call and redirect long outputs to `"$SCRATCH"/…` (the scratchpad,
SKILL.md "Tools"). Bash calls don't share variables: start each call with the assignments
it uses (`SCRATCH`, `HOST`, `R`, `P`, `MR`), as literal values. MRs are numbered by their
IID (`!42`).

## Host and project

The project comes from the URL argument when there is one, never from the cwd (setup.md
§ 1): `https://<host>/<group>/<sub>/<name>/-/merge_requests/<n>` → `HOST=<host>`,
`R=<host>/<group>/<sub>/<name>`, `P=<group>%2F<sub>%2F<name>` (the path URL-encoded, `/` →
`%2F`), `MR=<n>`. Without a URL, the same values come from the origin normalized in
setup.md § 1.

- Pass `-R "$R"` to every `glab mr` / `glab ci` / `glab issue` command (OWNER/REPO,
  GROUP/NAMESPACE/REPO or the full URL are accepted); `glab repo view` takes it as its
  argument. Pass `--hostname "$HOST"` to every `glab api` call.
- In `glab api` paths, use `projects/$P/...`, not `:id` / `:fullpath`: those are replaced
  with the cwd's project, which is not the URL's when the MR comes from elsewhere.
- `glab api` has no `--jq` flag (unlike `glab mr view`): pipe into `jq`.

```bash
HOST=gitlab.example.com R=gitlab.example.com/team/backend P=team%2Fbackend   # literal values
MR=$(glab mr view -F json | jq .iid)                       # no argument at all: MR of the current branch
glab api --hostname "$HOST" user | jq -r .username         # current user
```

## Snapshot

```bash
SCRATCH=/path/to/scratchpad R=gitlab.example.com/team/backend MR=42   # literal values
glab mr view "$MR" -R "$R" -F json > "$SCRATCH"/mr.json   # the API's merge request object
jq '{iid, title, web_url, state, draft, author: .author.username, source_branch, target_branch,
     sha, detailed_merge_status, has_conflicts, blocking_discussions_resolved,
     reviewers: [.reviewers[].username], head_pipeline: .head_pipeline | {id, status, web_url},
     description, created_at, updated_at}' "$SCRATCH"/mr.json
```

If a field is missing from `glab mr view` output (older glab), read the same object from
the API: `glab api --hostname "$HOST" projects/$P/merge_requests/$MR`.

Approvals:

```bash
glab api --hostname "$HOST" projects/$P/merge_requests/$MR/approvals | jq '{approved, approvals_required, approvals_left, approved_by: [.approved_by[].user.username]}'
glab api --hostname "$HOST" projects/$P/merge_requests/$MR/approval_state | jq '.rules[] | {name, approvals_required, approved, eligible: [.eligible_approvers[].username], approved_by: [.approved_by[].username]}'
```

(`approval_state` and approval rules are a paid-tier feature; on the free tier only
`/approvals` answers. `glab mr approvers $MR -R "$R"` lists eligible approvers.)

Discussions (review threads and comments):

```bash
glab api --hostname "$HOST" projects/$P/merge_requests/$MR/discussions --paginate | jq '[.[] | select(.notes[0].system | not) | {
  id, resolvable: .notes[0].resolvable, resolved: (.notes | map(select(.resolvable)) | all(.resolved)),
  path: .notes[0].position.new_path,
  notes: [.notes[] | {author: .author.username, created_at, body}]}]'
```

`glab mr note list $MR -R "$R" -F json --state unresolved` gives the same data, but is marked
experimental: prefer the API. System notes (`"system": true`) carry the history — "approved
this merge request", "added N commits", "requested review from" — useful for dating an
approval against the last push, and for dating each review request:

```bash
glab api --hostname "$HOST" "projects/$P/merge_requests/$MR/notes?sort=asc" --paginate \
  | jq '.[] | select(.system and (.body | test("requested review from"))) | {at: .created_at, body}'
```

CI:

```bash
glab ci get -R "$R" --merge-request=$MR --status=failed --with-job-details -F json   # failed jobs of the MR's head pipeline
glab api --hostname "$HOST" "projects/$P/pipelines/<pipeline-id>/jobs?scope[]=failed" | jq '.[] | {id, name, stage, status, failure_reason, web_url}'
glab api --hostname "$HOST" projects/$P/jobs/<job-id>/trace > "$SCRATCH"/job.log                         # full log, read the end
```

## Reading the fields

- **Reviews**: `reviewers` who have not approved nor commented since being requested are
  silent reviewers. A resolvable discussion not resolved is an open thread; who spoke last
  = author of its last note. `blocking_discussions_resolved == false` means the project
  requires resolved threads before merging (merge blocker). `detailed_merge_status ==
  mergeable` → reviewers still pending are not required: list them as optional
  ("reviewers requested, not required"), not as merge blockers.
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
  (`glab repo view "$R" -F json | jq -r .default_branch`) →
  `glab mr list -R "$R" --source-branch=<target_branch> -F json` (open MRs by default);
  open → blocker. GitLab also has explicit MR dependencies (`blocked_status`): see
  `glab api --hostname "$HOST" projects/$P/merge_requests/$MR/blocks` (check it exists on
  the instance).
- **Dependency MRs** named in the description ("depends on !123", an MR URL): extract every
  `!\d+` and MR URL, then `glab mr view <n> -R "$R" -F json | jq '{iid, state, title, web_url}'`
  (a URL from another project: its own `-R`). Open dependency → blocker.
- Bot authors: usernames with `bot` in them (`project_<id>_bot…`, `ghost`, renovate…).
- **Diff** (reference state, step 2): `glab mr diff $MR -R "$R" --raw > "$SCRATCH"/mr.diff`,
  then read only the files that carry the behavior.

## GitLab issues as the tracker

When the profile's tracker is `gitlab-issues`: `glab mr issues $MR -R "$R"` lists the issues
the MR closes, else a `#<n>` in the description.

```bash
glab issue view <n> -R "$R" -F json                      # body, state, assignees, labels
glab issue view <n> -R "$R" --comments                   # with comments (text)
glab api --hostname "$HOST" projects/$P/issues/<n>/notes --paginate | jq '.[] | select(.system | not) | {author: .author.username, created_at, body}'
glab api --hostname "$HOST" projects/$P/issues/<n>/links | jq '.[] | {iid, title, state, link_type, assignees: [.assignees[].username]}'
glab issue list -R "$R" --search "<keywords>" --all -O json # step 3 search (here -F is --output-format, not JSON)
```

Linked issues with `link_type == "is_blocked_by"` that are still open are dependencies.

## Mentions in drafts

`@username` in an MR or issue comment notifies the person.
