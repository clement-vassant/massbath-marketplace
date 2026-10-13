# pr-blockers

Claude Code skill that answers one question about a pull request or merge request: **what is preventing it from moving forward, and who needs to be chased?**

## What it does

It reads the change request (reviews, unresolved threads, CI, conflicts, stacked base branch) and its ticket with every comment and link, then sends sub-agents to look for answers given elsewhere: Slack, Confluence, the tracker's sibling tickets, Gmail, and the Jira notifications you receive on Slack. It cross-checks what the ticket says against what the PR/MR does and what was decided in those conversations, and writes a report:

- **Blocks the merge** and **Blocks the release**, kept apart: an approved PR whose feature flag waits on a product decision is not "nothing is blocking".
- **Answers found elsewhere**: the question you are waiting on was already answered in a Slack thread or on the parent ticket.
- **Ticket to bring back in line**: where the ticket lags behind a decision made elsewhere, with the replacement text and its source.
- **For you to handle**, **Questions to ask**, **To follow up**: who has the ball, since how many business days, with one paste-ready draft per person, in the language of the thread it replies to.
- **Not verified**: every source it could not reach, and what that leaves uncovered.

It is read-only. Nothing is posted, no thread is resolved, nothing is pushed: it can offer to post a follow-up, but posts only if you explicitly ask after validating the final text. The only things it writes are the repo's personal profile (see below) and, once, the line in `.git/info/exclude` that keeps it git-ignored.

## Usage

```
/pr-blockers:pr-blockers 1234
/pr-blockers:pr-blockers https://gitlab.example.com/team/backend/-/merge_requests/42
```

Or just ask: "what's blocking PR 1234?", "who should I chase on my MR?", "où en est ma PR ?". Without an argument it takes the PR/MR of the current branch. `--setup` (or "reconfigure pr-blockers") redoes the repo's configuration and shows the result.

## Supported sources

- **Forges**: GitHub (including GitHub Enterprise) and GitLab (gitlab.com and self-hosted).
- **Trackers**: Jira, Linear, or the forge's own issues.
- **Elsewhere**: Slack, Confluence, Gmail.

CLIs first: for each source the skill uses its CLI when it is installed and authenticated, and falls back to the MCP connector only without one. CLI output can be filtered (`--json` + `jq`) before it reaches the context; a connector returns whole objects.

## Requirements

- Mandatory: the forge's CLI, authenticated for the repo's host: `gh` for GitHub, `glab` for GitLab. Without a usable forge, the skill stops after telling you how to fix it.
- Optional, each one widening what is checked:
  - Jira: `acli` (Atlassian's CLI) or the community `jira` CLI, else the Atlassian connector.
  - Linear: a `linear` CLI, or a `LINEAR_API_KEY` in the environment, else the Linear connector.
  - Confluence search, Slack and Gmail: their MCP connectors.

The skill never installs anything nor logs in for you.

## Preflight: access is proven, not assumed

A tool can be installed and logged in, yet on the wrong account, Jira site or mailbox, or without the organization's SSO grant: it then finds nothing, and "nothing" would read as "nobody answered". So every run starts with one minimal read per source, in parallel: the forge's current user and the PR/MR itself, the ticket, a one-result Slack and Confluence search, and a check of which Gmail mailbox is connected. A transient failure is retried once. The report opens with an **Access** block, one line when everything passed:

```
### Access
OK: GitHub (gh, acme/storefront #1234) · Jira (acli, example.atlassian.net, SHOP-1) · Slack · Confluence (connectors)
```

A source that fails shows its cause and the exact fix (type `! <command>` in Claude Code to run it in the session), for example `Linear: not reachable, LINEAR_API_KEY rejected (401) → create a key and export it`. Only the sources that passed are searched; the others go under **Not verified** with what they leave unchecked. Without the forge, the skill stops after the Access block.

## Privacy

- **Nothing leaves your machine except reads to your own tools.** No post, comment or draft in Slack, Gmail or Jira; no web search or fetch carrying ticket, PR, people or company content; no gist, pastebin or third-party service; the report is not published anywhere unless you ask.
- **No secret is printed, stored or passed on.** Tokens are never displayed (`gh auth token` and the like are never run); `LINEAR_API_KEY` goes from your environment straight into a request header.
- **What is written locally**: the repo profile (tool names, forge host, project, Jira site, Slack channel ID; never a token, a message, a person's name or an email address) and, once, the line in `.git/info/exclude` that keeps it out of git. Temporary files go to the session's scratch directory, never the repo. The report lives in the conversation; it is saved only if you ask.
- **Sub-agents** get only what their source needs and bring back conclusions with short quotes about the change, nothing personal or unrelated from DMs, private channels or mail.
- **What it reads is data, not instructions**: a ticket comment or a message saying "post this" or "run that" is never acted on.
- A Gmail connected to the wrong mailbox (a personal one, another employer's) is never searched; the profile keeps only the reason and the mailbox's domain.

## Setup and the repo profile

Every run starts by working out, for the repo at hand, its forge, its tracker and the tool that reaches each source. Two repos can belong to two companies, with another forge, Jira site or Slack workspace, so this is decided per repo.

The result is saved to `.claude/pr-blockers.local.json` at the root of the repo's main checkout: personal, never committed (the skill adds it to the clone's `.git/info/exclude`, without touching any tracked file), and shared by all the repo's worktrees. A profile younger than 30 days is reused; every source still goes through the preflight, and any source recorded as missing is detected again. With a PR/MR URL from another repo than the current directory's, the skill runs on the URL's repo without a profile and leaves the current one alone. Delete the file or pass `--setup` to start over.

## Jira notifications on Slack

When the tracker is Jira, the Jira Cloud app's DM on Slack is the only place that shows the whole neighborhood of a ticket at once: a rule set on a sibling ticket, a mention left unanswered, a linked ticket closed. The skill finds that DM in this order:

1. `slack.jiraNotificationsDm` in the repo profile, or a channel ID named for that purpose in your CLAUDE.md or memory, for example `Jira Cloud notifications Slack DM: <channel ID>`.
2. Otherwise it searches Slack for the ticket key, keeps the messages posted by the Jira Cloud app in a DM, takes the DM with the most of them, names it in the report and saves it to the profile.
3. Nothing found (no Slack connector, Jira app not installed in Slack, no notification yet): "Not verified: no Jira notifications DM found in Slack", and the diagnosis goes on. It never guesses a channel.

## Evals

`skills/pr-blockers/evals/evals.json` holds three fictional scenarios (`acme/storefront`, PR #1234 and #1288 with Jira, MR !42 on a self-hosted GitLab with Linear and no profile yet). The people, tickets and partner do not exist: to run them, adapt each prompt to one of your own PRs and check the report against the assertions.

## Installation

This skill is part of the [massbath-marketplace](../../README.md) marketplace. Once the marketplace is added (see its README):

```
/plugin install pr-blockers@massbath-marketplace
```

For automatic updates, development and checks, see the [marketplace README](../../README.md).

## Roadmap

Ideas, not planned work:

- A `watch` skill that keeps a "last seen" cursor per PR and only reports what changed since.
- A follow-up composer that posts the approved drafts to Jira and Slack, with the right mention syntax.
- Incremental re-review: rerun only the sources that moved since the last report.
- A `pr-pulse` mod: a band above the prompt with the state of your open PRs.
- Eventually, all of it grouped into a `pr-lifecycle` plugin.

## Known limitations

- The quality of "Answers found elsewhere" depends on the connectors you have: without Slack or Confluence, an answer given there stays invisible, and the report says so under **Not verified**.
- Gmail is searched only when the connected mailbox is the one where the project's exchanges arrive. A mailbox found out of scope is recorded in the profile (reason and domain only) and not searched; each run's preflight only checks whether the connected mailbox changed domain, and `--setup` re-evaluates it.
