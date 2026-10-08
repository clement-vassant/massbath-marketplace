# plan-review

Claude Code mod (v2.1.287+) for executing a plan with subagents and a human review between each task.

## What it does

- **Band above the prompt**: the plan's progress bar, the current task, the number of active subagents, and a marker when a review is waiting for you. `0` (empty prompt) opens the pane.
- **`/plan-review` pane** (the command opens or closes it), three tabs:
  - `1` **Plan**: each task with its status (○ to do, ◐ running, ◆ in review, ✎ to fix, ● approved), the number of agents launched and your latest comment.
  - `2` **Agents**: each subagent with its task, type, number of tool calls, duration, last tool used, then an excerpt of its report once done.
  - `3` **Review**: the task summary (markdown, files changed, tests, points of attention), a comment field and two buttons: `v` **Approve and continue**, `c` **Request changes**.
- **A real review gate**: while a review is pending, the orchestrator can no longer launch a subagent, edit a file or start a task. The mod refuses those calls; it is not just an instruction in the prompt.
- Your decision resumes Claude automatically with a clear message: task approved (with your note, if any) or changes requested (with your comment).
- The plan is saved per working directory. It survives a restart, `/clear` and `/resume`.

## How Claude uses it

The mod adds four tools and a short instruction to the system prompt:

- `plan_set`: declares the plan (T1, T2…) at the start
- `task_start`: before launching a task's subagents
- `task_review`: at the end of a task, instead of asking for approval in the chat
- `plan_review`: once every task is approved, submits the summary of the whole plan for a final review. Approving it closes the tracker (plan cleared, pane closed) without resuming Claude. Requesting changes sends your comment back, as for a task.

Just ask, for example: "Execute the plan in `docs/plan.md` with subagents, with a review between each task."

## Installation

This mod is part of the [massbath-marketplace](../../README.md) marketplace:

```
/plugin marketplace add clement-vassant/massbath-marketplace
/plugin install plan-review@massbath-marketplace
```

For automatic updates, development and checks, see the [marketplace README](../../README.md).

`/plan-reset` clears the tracked plan for the current folder.

## Known limitations

- The mod only sees subagents when they start, when they call tools and when they finish. Their reasoning is not streamed.
- The quality of the summary depends on what the orchestrator writes in `task_review`.
- Like any mod, it runs with your permissions and without a sandbox.
