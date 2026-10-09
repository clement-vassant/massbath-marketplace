---
name: pr-blockers
description: >-
  Diagnose where a GitHub Pull Request stands and what is holding it up: pending or
  unresolved reviews, red CI, conflicts, ticket dependencies, open questions on the Jira or
  Linear ticket — then uses sub-agents to check whether answers were given elsewhere (Slack,
  Confluence, Jira, Gmail) and in the Jira notifications received on Slack (mentions,
  comments on sibling tickets, transitions), cross-checks the sources to spot what
  contradicts the ticket (and proposes how to bring it back in line), separates what blocks
  the merge from what blocks the release, and lists the questions to ask and the people to
  follow up with, with one follow-up draft per person. Nothing is sent. Use it whenever the
  user asks "where is my PR at", "what's blocking PR #1234", "who should I chase", "PR
  status", "the PR is stuck", "why won't it merge", "status of my PRs", or pastes a PR URL
  asking for a status — even without explicitly mentioning blockers or follow-ups. Also
  when they are waiting for an answer (PO, reviewer, partner) on a PR's ticket and want to
  know whether it was given in the meantime on Slack, Confluence, Jira or by email. Also
  when they want to check that a PR's ticket is still up to date, or spot contradictions
  between the ticket, the PR, the docs and the conversations. French triggers: « où en est
  ma PR », « qu'est-ce qui bloque la PR », « qui dois-je relancer ».
  Not for applying review feedback (use a review-fixing skill if you have one) nor for
  doing a code review.
argument-hint: "[pr-number | pr-url]"
---

# PR blockers

Answer a single question: **what is preventing this PR from moving forward, and who needs
to be chased?** The skill is read-only: it collects, cross-checks, and writes drafts. It
posts nothing, resolves no thread, pushes nothing — a badly targeted follow-up, or one sent
twice, costs more than a copy-paste.

Write the report in the user's language; each follow-up draft is in the language of the
thread it replies to.

The main pitfall is declaring "waiting on X" when X has already answered elsewhere (a Slack
thread, a Confluence page, a comment on the parent ticket). That is why step 3 looks for
answers outside GitHub before concluding.

## 0. Identify the PR and the user

- PR: the argument (number or URL). Otherwise `gh pr view --json number -q .number` on the
  current branch. URL from another repo → pass `--repo owner/name` to every `gh` command.
- User: `gh api user -q .login`. You need to know who "I" am to tell "I'm waiting on
  someone" from "someone is waiting on me".

## 1. GitHub snapshot (main agent)

Each source in its own command: a failing command must not hide another one, and a call
that errored is never "empty" (retry before concluding).

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner); OWNER=${REPO%/*}; NAME=${REPO#*/}

gh pr view $PR --json number,title,url,state,isDraft,author,baseRefName,headRefName,body,\
mergeable,mergeStateStatus,reviewDecision,reviewRequests,latestReviews,createdAt,updatedAt
gh pr checks $PR --json name,state,bucket,link,completedAt   # CI: failures, pending
gh api repos/$REPO/issues/$PR/comments --jq '.[] | {user: .user.login, created_at, body}'
gh api repos/$REPO/pulls/$PR/reviews  --jq '.[] | {user: .user.login, state, submitted_at, body}'
gh api graphql -f query="{ repository(owner:\"$OWNER\", name:\"$NAME\") { pullRequest(number:$PR) {
  reviewThreads(first:100) { nodes { isResolved isOutdated path
    comments(first:30) { nodes { author { login } createdAt body url } } } } } } }"
```

(`reviewThreads` is not a valid field of `gh pr view --json`: go through GraphQL.)

Comment bodies are long: redirect each output to a file in the scratchpad and then read it,
rather than receiving it directly — an output proxy (rtk, for example) can truncate a long
JSON and drop the end of a comment, which is often where the reservation is. To separate
outputs, avoid `echo ===…`: in zsh, `=word` is a command expansion and the line fails.

To extract:

- **Reviews**: requested reviewers who have not responded (`reviewRequests`), still-active
  `CHANGES_REQUESTED`, unresolved threads — and for each one **who spoke last**. If it is
  the user, the ball is in the reviewer's court (to follow up); otherwise it is in the
  user's court (to handle, not to chase). A `DISMISSED` review, or an approval whose
  `commit_id` is not the current head while `reviewDecision` ≠ `APPROVED`, was invalidated
  by a push: that is a re-approval to request from that reviewer.
- **CI**: failing or stuck checks, with the job name. Tell a PR failure from an
  infrastructure failure (expired token, runner) when the log shows it.
- **Conflicts**: `mergeable == CONFLICTING` or `mergeStateStatus == BEHIND/DIRTY`.
- **Stacked PR**: `baseRefName` is not the main branch → find the PR for that base
  (`gh pr list --head <baseRefName>`); if it is open, that is a blocker.
- Ignore `*[bot]` authors for reviews, but not for CI (Sonar, etc.).

GitHub, Jira and Slack timestamps are in UTC: convert them to the local time zone
(`date +%Z`) before displaying them, otherwise "approved at 07:40" contradicts what the user
saw at 09:40.

Also read **a reviewer's last comment even when the PR is approved**: an approval often
comes with reservations ("OK to merge, but before turning the flag on…") that are the real
blockers for what comes next.

## 2. Ticket: Jira or Linear

Find the key in this order: explicit URL in the body (`atlassian.net/browse/…` → Jira,
`linear.app/…/issue/…` → Linear), then a `[A-Z]+-\d+` key in the title / branch / body.
A bare key is ambiguous (Jira and Linear share the same format): try Jira first if the
Atlassian connector is present, then Linear; if neither finds it, say so.

- **Jira**: load the Atlassian tools via ToolSearch. Get the cloudId with
  `getAccessibleAtlassianResources` (do not guess the site: a wrong site returns
  "not granted"). Read the ticket **with all its comments**, its status, its assignee, its
  links (`is blocked by`, `depends on`) and its parent/epic.
- **Linear**: load the Linear tools via ToolSearch. If they require authentication, flag it
  in the report ("Linear not connected: ticket questions not checked") and continue — do
  not block the whole diagnosis.

Reread the thread **in full, down to the last comment**, before listing a question as open:
a question asked and then answered three comments below is not open. An **open question** =
a question (from the user or addressed to them) with no explicit answer further down the
thread. For each one, note: author, addressee (mention or obvious role: PO, reviewer…),
date, link, and 3–6 keywords for the search.

Dependencies: any `is blocked by` link to an unfinished ticket is a blocker, with that
ticket's assignee as the person to chase.

**Reference state.** The ticket is supposed to be authoritative: it is what the developer,
the tester and the PO reread. Extract from it the list of **statements** it makes (business
rules, acceptance criteria, values, API contract, expected behavior, scope), each with a
short marker ("BR-18", "AC 3", "description § Contract"). Do the same for what the PR
**actually does**: PR description, commit messages, and the diff when the description is
not enough (`gh pr diff $PR`, reading only the files that carry the behavior). These two
lists are used in step 4 to cross-check the sources.

## 2b. Jira notifications received on Slack (sub-agent)

The Jira Cloud app pushes into a Slack DM every mention, comment, transition or description
update on the tickets the user watches or owns. It is the only place that gives, **in one
go**, the activity of the ticket's whole neighborhood: a decision made on a sibling ticket
of the epic (a rule set on a sibling ticket — "an unchanged request returns 200 with status
DONE" — while the PR returns 400), a mention left unanswered, a linked ticket moved to
`Closed`. The main ticket's Jira thread shows none of that.

**Find the DM first**, in this order:

1. If the user's instructions or memory (CLAUDE.md, memory files) name the Slack channel ID
   of their Jira Cloud notifications DM, use it.
2. Otherwise discover it: load the Slack tools via ToolSearch; search messages
   (`slack_search_public_and_private`) for the ticket key, and keep the results posted by
   the Jira Cloud app (bot/app author named "Jira" or "Jira Cloud") in a channel whose ID
   starts with `D` (a DM). If several DMs match, take the one with the most Jira-app
   messages, and name the one you used in the report.
3. If nothing is found (no Slack connector, Jira app not installed in Slack, no
   notification yet) → "Not verified: no Jira notifications DM found in Slack", and
   continue with the next steps. Never guess a channel.

When discovery succeeded (case 2), suggest once, in one line at the end of the report, that
the user save the DM ID in their CLAUDE.md to skip discovery next time.

Launch a `general-purpose` sub-agent as soon as the main ticket has been read (it needs its
key, its epic and its links) and the DM is known. The DM is verbose (tracking URLs,
avatars): the sub-agent absorbs that noise and returns only a table.

> Read the Jira notifications in the Slack DM `<DM channel ID>` (`slack_read_channel`,
> concise format, paginating; `oldest` = the PR's creation date <date>, or that of the
> oldest open question if earlier). Read-only. Load the Slack and Atlassian tools via
> ToolSearch (cloudId: `getAccessibleAtlassianResources`).
> Tickets in scope: <main key>, epic <key>, links <keys>. Add any ticket that appears in the
> notifications and whose parent is that epic (check the parent in Jira, do not guess it
> from the title).
> For each in-scope notification, one row: ticket, type (mention / comment / transition /
> description / attachment), author, local date-time, comment id (`focusedCommentId` in the
> URL), link.
> - Deduplicate by comment id: a repeated notification is an edit, keep the most recent.
> - The Slack excerpt is **truncated** (often cut off with "…"): for any in-scope mention
>   or comment, reread the full comment in Jira before summarizing it.
> - For each mention of the user, say whether they replied **afterwards** in the Jira thread
>   (their own comments do not generate notifications: check in Jira).
> - For a comment on a sibling ticket, say in one sentence whether it touches the scope of
>   the PR <title + 2-line summary of the change> (rule, decision, API contract, expected
>   behavior) or not.
> Return the table, then three lists: mentions the user has not answered, decisions or rules
> set elsewhere that touch the PR, transitions of linked tickets. Make nothing up.

If the DM is inaccessible (no Slack connector, channel not found), flag it under "Not
verified": without it, sibling-ticket activity is not covered.

How to use it:

- **Mention the user has not answered** → "For you to handle", even if it is not a
  well-formed question. A misunderstanding ("I don't understand what is expected of me") is
  a stuck question: the ball is in the user's court, and the rephrasing goes into "Questions
  to ask" with a draft.
- **Decision or rule set on a sibling ticket** → check it against the PR's behavior. If it
  confirms it: "Answers found elsewhere". If it contradicts it or raises a reservation (API
  contract, front-end prerequisite): a release blocker, or a merge blocker if the PR's code
  has to change.
- **Transition** → updates the state of dependencies (an `is blocked by` moved to `Closed`
  is no longer a blocker).
- The comments found here join the open questions from step 2 and the brief of the step 3
  sub-agents.

## 3. Look for answers elsewhere (sub-agents in parallel)

Always run this step, even with no open question: it also serves to spot what, elsewhere,
contradicts the ticket.

Launch **in a single message** four `general-purpose` sub-agents (in addition to the one
from step 2b), one per source (Slack, Confluence, Jira, Gmail). Exchanges with an external
partner (sample payloads, specs, confirmations) often arrive by email and exist nowhere
else. Each receives the same brief and returns only conclusions (no dumps), which keeps the
main context clean:

> You are looking for whether answers were given to questions blocking PR <url> (ticket
> <key>, title "<title>"). Source: **<Slack | Confluence | Jira | Gmail>**, read-only.
> First load this source's tools via ToolSearch.
> Open questions: <numbered list: text, author, addressee, date, keywords>.
> Silent reviewers: <list of login + since when>.
> Search from each question's date: ticket key, PR number/URL, keywords, people's names.
> <source-specific instructions>
> For each question, return: `answer found | partial lead | nothing`, with author, exact
> date and time, link and a short quote (≤ 2 sentences). Also flag any recent discussion
> about the PR/ticket that changes the situation (decision made, priority changed, someone
> on leave).
> Ticket statements (reference state): <list marker → statement>.
> Also return, topic by topic, **any statement found on the same topic** (rule, value,
> contract, expected behavior, scope), whether it confirms or contradicts the ticket: quoted
> text, author, role if known, date-time, link, and whether it is a decision, a proposal or
> a question. Flag the contradicting ones first. Make nothing up: no link = no answer.

Per-source instructions:

- **Slack**: public and private search (ticket key, PR number and URL, keywords), excluding
  the Jira notifications DM, already read in 2b.
  Read the threads found in full — the answer is often in a thread reply.
  Spot announced absences ("on leave until…") of the people to chase.
- **Confluence**: CQL on the ticket key and the keywords (specs, meeting notes, decisions);
  look at pages modified after the question's date.
- **Jira** (excluding the main ticket, already read in step 2): epic/parent, linked tickets
  and sibling tickets, JQL search `text ~ "<keyword>"` on the same project — product
  answers often land on the epic ticket or a neighboring ticket.

- **Gmail**: start by checking which mailbox is connected (profile address). If it is not
  the mailbox where the project's exchanges arrive (another employer's mailbox, a personal
  one), do not search: return "connected mailbox = <address>, out of scope" for the Not
  verified section. Otherwise, search on the ticket key, the partner's name and the
  keywords, from each question's date. Return sender, date, subject and the useful excerpt;
  flag relevant attachments (a sample payload to attach to the ticket, for example). Never
  quote off-topic personal information.

If the ticket is on Linear, the "Jira" agent searches Linear instead (linked issues,
project, comments), or is omitted if Linear is not connected.

Once the agents have returned their results, stop them (TaskStop) if they are still alive.

## 4. Synthesis

**Two blocking horizons.** A PR can be mergeable while the feature cannot be shipped yet
(feature flag off, acceptance testing to do, a product question that gates activation, an
activation ticket waiting on other tickets). Put each blocker in one of the two:

- **Blocks the merge**: missing or invalidated review, requested changes, red CI, conflict,
  base PR still open.
- **Blocks the release**: anything that has to be settled before the code actually serves
  (flag activation, acceptance testing, product or partner sign-off, linked tickets).

A "ready to merge" PR with release blockers is not a "nothing is blocking" case: that is
often where the bulk of it lies.

### 4a. Cross-check the sources and bring the ticket back in line

Decisions get made all over the place (a Slack thread, a comment on a sibling ticket, a line
on the questions page, a sample payload from the partner) and the ticket is not always
updated. The result: the ticket, the PR, the docs and the conversations tell different
stories, and whoever rereads the ticket (tester, PO, future developer) gets it wrong. The
goal here is to list those gaps and say how to make the ticket authoritative again.

Group all the collected statements by **topic**: ticket description, ticket comments,
sibling tickets (step 2b and the Jira agent), Confluence, Slack, email, PR description and
the code's actual behavior. For each topic where two sources diverge, determine what is
authoritative:

- **The most recent decision made by someone with authority on the topic**: the PO for a
  product rule, the partner for their format or API (a written statement or a real sample
  payload beats a verbal one), the team or the reviewer for an internal technical choice. An
  unanswered proposal, or a question, is not authoritative.
- Compare timestamps. If a source's timestamp is not reliable (modification date of a whole
  page, not of a line), say so instead of deciding.

Then classify the gap. Each category leads to a different action:

| Situation | Action |
|-----------|--------|
| The ticket lags behind a decision made elsewhere | **Ticket to bring back in line**: propose the new text, cite the decision as the source |
| The PR's code diverges from an up-to-date ticket | **Code to fix** (blocks the merge) — or ticket to fix if it is the code that follows the latest decision |
| PR description, tracking page or sibling ticket lagging behind | **To propagate**: say what to change and where |
| Two decisions that contradict each other with neither clearly later, or two people with authority who disagree | **Question to ask**, with both quotes: do not decide for them |

A gap found on a sibling ticket that touches the PR's behavior (a rule set on another
ticket of the epic, which contradicts what the PR does) is the most expensive case if it
goes unnoticed: raise it even if nobody has pointed it out.

List only real gaps of substance (rule, value, contract, behavior, scope). A difference in
wording with no consequence is not one.

### 4b. Answers, follow-ups and questions

**A decision made counts as an answer, even if the tracking doc has not caught up.** When
the people with authority have settled it somewhere (a Slack thread where the team agrees,
a PO comment), the question is closed as far as the PR's progress goes, even if a tracking
page or a questions table still marks it "to do". Do not put it back as a blocker: file it
under "Answers found elsewhere" with the note "tracking page to update". It only stays open
if someone else still has to validate it explicitly (a partner who has not confirmed, while
the team made it a condition), and then you must say so.

Cross-check: a question for which an agent found an answer is **no longer** a blocker — it
becomes "answer found on <source>, to carry over to the ticket/PR" (an action for the user,
not a follow-up). A partial lead stays open, but the follow-up can build on it.

**Follow up or ask?** Distinguish:

- **To follow up**: the question was asked to the right person, on a channel they read, and
  they have not answered. Compute the age in business days; under one business day, note it
  "too early to follow up".
- **Question to ask**: the question was never asked in this form to the person who can
  decide (a newly discovered gap, an old answer contradicted by a more recent fact, a
  reviewer's reservation that calls for a product decision). No age: it is to be done now.

**Closing windows.** Spot nearby deadlines announced in the sources ("I'm sending the
questions to the partner around noon", "committee tomorrow morning", "release freeze on
Friday", "on leave from Thursday"). If a question to ask or a follow-up has to go out before
that deadline to avoid losing a cycle, it is the most actionable point of the report: put it
at the top, with the current local time and the deadline.

Follow-up channel: the one where the question was asked (GitHub thread for a reviewer,
Jira/Linear comment for a product question), or a direct Slack message if the question has
already been followed up without effect on that channel. The draft quotes the question and
its link, stays short, and is in the language of the original thread.

## Report format (terminal)

```
## PR #<n> — <title>
<url> · <one-line status: e.g. "approved, CI green, blocked by 2 PO questions">

### ⏰ Urgent
- <deadline> (<source, link>) — it is <local time>: <action to take before, pointer to the draft>

### Blocks the merge
| # | Blocker | Type | Ball in court of | Since |
|---|---------|------|------------------|-------|
(types: review, CI, conflict, base PR; from most to least blocking)

### Blocks the release
| # | Blocker | Type | Ball in court of | Since |
|---|---------|------|------------------|-------|
(types: question, review reservation, acceptance testing, flag, dependency)

### Answers found elsewhere
- <question> → <short answer> — <author>, <date>, <link> → to carry over to <ticket/PR>

### Ticket to bring back in line (<key>)
| # | Topic | The ticket says | Now authoritative | Source (author, date, link) |
|---|-------|-----------------|-------------------|-----------------------------|

Proposed update (only the passages that change, ready to paste into the
description):
> **<marker, e.g. BR-18>** — <new text>

To propagate: <PR description, Confluence page, sibling ticket: what to change, where>
Unresolved gaps → see "Questions to ask".

### For you to handle
- <what is waiting on the user: thread where they must reply, CI to fix, rebase…>

### Questions to ask
**<Person>** (<role>) — <what needs deciding and why now> · channel: <channel>
> <draft ready to paste>

### To follow up
**<Person>** (<role>) — <reason>, waiting for <n> business days · channel: <channel>
> <follow-up draft ready to paste>

### Not verified
- <sources inaccessible or in error, e.g. Linear not connected, no Jira notifications DM found in Slack>
```

Omit an empty section rather than writing "nothing", **except "To follow up"**: that is the
question the user is asking, it deserves an explicit answer even if negative ("Nobody to
follow up with: <one-line reason>"). If the cross-check finds no gap, say so in one line
("Ticket consistent with the PR and the conversations"): that is information, not an empty
section. A person concerned by several points gets a single draft that groups them. If
nothing blocks **either the merge or the release**, say so in one line ("ready to merge and
ship, nobody to follow up with") and stop there.

Then offer, in one line, to post a follow-up — but post nothing without the user's explicit
approval of the final text. For a Jira @-mention through the Atlassian connector, use the
ADF format (`mention` node): in markdown the mention is escaped and nobody is notified.
