# Tracker: Jira (and Confluence)

Order: `acli` (Atlassian's official CLI) → community `jira` CLI → Atlassian MCP connector.
Use the tool saved in the profile; redirect outputs to `"$SCRATCH"/…` (the scratchpad,
SKILL.md "Tools", never the repo).

## acli

Check: `acli jira auth status` (logged-in account and site). The site must be the
profile's `trackerSite`; otherwise `acli jira auth switch`. Not logged in → suggest
`acli jira auth login --web`.

```bash
acli jira workitem view KEY-1 --fields '*all' --json > "$SCRATCH"/ticket.json   # status, assignee, parent, issuelinks, description
acli jira workitem comment list --key KEY-1 --paginate --json > "$SCRATCH"/comments.json
acli jira workitem link list --key KEY-1 --json                           # is blocked by / blocks / relates
acli jira workitem search --jql 'parent = EPIC-1' --fields 'key,summary,status,assignee' --json --paginate
acli jira workitem search --jql 'project = PROJ AND text ~ "keyword" AND updated >= -30d' --json --limit 50
```

- `*all` is heavy; once you know which fields you need, list them (`--fields
  'summary,status,assignee,parent,issuelinks,description'`) or extract with `jq`.
- Descriptions and comment bodies come in ADF (JSON document): extract the text nodes with
  `jq '.. | .text? // empty'` rather than reading the raw tree.
- `parent` gives the epic on team-managed and recent company-managed projects; on older
  projects the epic can be in an "Epic Link" custom field.

Confluence with acli: `acli confluence page view --id <page-id> --body-format storage
--include-version --json` reads a known page (ID from a link). acli has no Confluence
search: CQL search goes through the connector (`searchConfluenceUsingCql`), preferred for
Confluence whenever it is present; with acli alone, read only the pages already linked and
put "Confluence search" under "Not verified" (setup.md § 3).

## Community jira-cli (ankitpokhrel/jira-cli)

If `command -v jira` finds it and the profile says `jira`: it covers viewing an issue with
its comments and JQL listing. Its flags differ from acli and between versions — check
`jira issue view --help` and `jira issue list --help` before use rather than guessing.

## Atlassian MCP connector (fallback)

Load the Atlassian tools via ToolSearch. Get the cloudId with
`getAccessibleAtlassianResources` (do not guess the site: a wrong site returns "not
granted"), and pass it to every call. Read the ticket with `getJiraIssue` (comments
included), search with `searchJiraIssuesUsingJql`, Confluence with
`searchConfluenceUsingCql` / `getConfluencePage`. Ask only for the fields you need: the
connector returns whole objects.

## Mentions in drafts

A Jira @-mention must be an ADF `mention` node (with the person's accountId) when posted
through the connector or the API: written as markdown `@name`, it is escaped and nobody is
notified. In a draft for the user to paste in the Jira UI, write `@Name` and let them pick
the person from the autocomplete.
