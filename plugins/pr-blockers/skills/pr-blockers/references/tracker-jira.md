# Tracker: Jira (and Confluence)

Order: `acli` (Atlassian's official CLI) → community `jira` CLI → Atlassian MCP connector.
Use the tool saved in the profile; redirect outputs to `"$SCRATCH"/…` (the scratchpad,
SKILL.md "Tools", never the repo).

## acli

Check: `acli jira auth status` (logged-in account and site). The site must be the
profile's `trackerSite`; otherwise `acli jira auth switch`. Not logged in → suggest
`acli jira auth login --web`.

```bash
SCRATCH=/path/to/scratchpad   # literal value
acli jira workitem view SHOP-1 --fields 'summary,status,assignee,parent,issuelinks,description,updated' --json > "$SCRATCH"/ticket.json
acli jira workitem view SHOP-1 --fields comment --json > "$SCRATCH"/comments.json
acli jira workitem search --jql 'parent = SHOP-10' --fields 'key,summary,status,assignee' --json --paginate
acli jira workitem search --jql 'project = SHOP AND text ~ "keyword" AND updated >= -30d' --json --limit 50
```

Render the comments (author, date, id, text with mentions and links) from the saved file:

```bash
jq -r '.fields.comment.comments[] | "--- [\(.id)] \(.author.displayName) \(.created)\n" + ([.body|..|objects| if .type=="mention" then "@"+(.attrs.text|ltrimstr("@")) elif .type=="text" then .text elif .type=="hardBreak" or .type=="paragraph" then "\n" elif .type=="inlineCard" then .attrs.url else empty end]|join(""))' "$SCRATCH"/comments.json > "$SCRATCH"/comments.txt
jq '.fields.comment | {total, maxResults, returned: (.comments|length)}' "$SCRATCH"/comments.json
```

Possibly capped: `total == maxResults` (e.g. 20 and 20: exactly 20, or cut at 20?) or
`total` > `returned`. `view` has no paging flag (`--fields`, `--json`, `--web` only), so
get the full set from `comment list`, which pages:

```bash
acli jira workitem comment list --key SHOP-1 --paginate --json | jq -s '[.[] | .. | objects | select(has("id") and has("body"))] | unique_by(.id)' > "$SCRATCH"/comments-all.json
jq 'length' "$SCRATCH"/comments-all.json   # compare with total
```

Those give ids and bodies only: dates and mentions come from `view` for the comments it
returned; for the others, say "date unknown" / "mention not resolved". Count still short
of `total`, or `comment list` fails → "comments possibly truncated" under "Not verified".

- Comments come from `view --fields comment`; `comment list` only to fill a capped list
  (above): `comment list --json` returns no dates and strips mention nodes, and with
  `--paginate` it prints one JSON document per page (the last one empty) — hence `jq -s`.
- A mention can render as an opaque account placeholder instead of a name: resolve it
  from the context or say so, never guess.
- Links, parent, status, assignee come from `view` (`issuelinks` holds both directions,
  with each linked ticket's key and status). Not `workitem link list`: inward links come
  back without key or status.
- `search --fields` accepts only a few fields (`key`, `summary`, `status`, `assignee`,
  `issuetype`, `priority`); `updated`, `created`, `parent` are rejected ("field '…' is not
  allowed"). Anything that needs dates or the parent → one `view` per ticket.
- Comment edit history is not available (acli nor API): the current Jira text is the one to
  quote, even if a notification showed an older wording.
- `*all` is heavy: list the fields you need, as above.
- Descriptions come in ADF (JSON document): extract the text nodes with
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

Two Atlassian connectors can be loaded side by side: one with direct tools (`getJiraIssue`,
`searchConfluenceUsingCql`…), another with `discover` / `executeRead`. Either works; for
Confluence, prefer the one that exposes CQL search.

Who wrote a given line of a Confluence page, and when (the page's modification date covers
the whole page): use the page's version-history and version-diff operations, found through
the connector's `discover`. Request the full response: restricting the response fields can
return an empty diff.

## Mentions in drafts

A Jira @-mention must be an ADF `mention` node (with the person's accountId) when posted
through the connector or the API: written as markdown `@name`, it is escaped and nobody is
notified. In a draft for the user to paste in the Jira UI, write `@Name` and let them pick
the person from the autocomplete.
