# Tracker: Linear

Order: a `linear` CLI if installed and authenticated → the GraphQL API with `curl` if
`LINEAR_API_KEY` is set → the Linear MCP connector → "Not verified: Linear not connected,
ticket questions not checked" (and continue the diagnosis).

## linear CLI

Several community CLIs exist under the name `linear`, with different commands. Run
`linear --help` (then the issue subcommand's `--help`) to find how to view an issue with
its comments and how to search; prefer a JSON output option if there is one. Do not guess
flags; if it cannot show comments, use the API below for them.

## GraphQL API with curl

Personal API keys go in the `Authorization` header as is (no `Bearer`). The key never goes
in a file or in the report.

```bash
linear_q() {  # $1 = GraphQL query, $2 = variables JSON
  v=${2:-"{}"}
  curl -sS https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg q "$1" --argjson v "$v" '{query: $q, variables: $v}')"
}

linear_q 'query($id: String!) { issue(id: $id) {
  identifier title url description priority
  state { name type } assignee { name displayName } creator { name }
  parent { identifier title state { name } }
  project { name }
  relations { nodes { type relatedIssue { identifier title state { name type } assignee { name } } } }
  inverseRelations { nodes { type issue { identifier title state { name type } assignee { name } } } }
  comments(first: 100) { nodes { body createdAt user { name displayName } parent { id } url } }
} }' '{"id": "ENG-123"}' > ticket.json
```

- `issue(id:)` accepts the human key (`ENG-123`) as well as the UUID.
- Dependencies: a `blocks` relation in `inverseRelations` means the other issue blocks this
  one; still open (`state.type` not `completed` / `canceled`) → blocker, chase its assignee.
- Comments with a `parent` are thread replies: reread the thread down to the last reply.
- Step 3 search (sibling issues, keywords): the parent's `children`, the project's issues,
  or the full-text search query — `searchIssues(term: "…")` in the current schema. If the
  API answers with a schema error, the field was renamed: read the error message, it names
  the valid fields.

## Linear MCP connector (fallback)

Load the Linear tools via ToolSearch. If they require authentication, treat Linear as not
connected (see above) rather than blocking.

## Mentions in drafts

In a draft to paste in Linear, write `@name` and let the user pick the person from the
autocomplete.
