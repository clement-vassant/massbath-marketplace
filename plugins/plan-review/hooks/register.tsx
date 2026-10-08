import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { AgentRun, AgentStep, Plan, Review, Tab, Task, TaskStatus } from '../types'

// ---------------------------------------------------------------------------
// Reactive state (survives module reloads, not /clear)
// ---------------------------------------------------------------------------
const planAtom = atom({ plugin: 'plan-review', key: 'plan' } as const, null)
const reviewAtom = atom({ plugin: 'plan-review', key: 'review' } as const, null)
const agentsAtom = atom({ plugin: 'plan-review', key: 'agents' } as const, [])
const tabAtom = atom({ plugin: 'plan-review', key: 'tab' } as const, 'plan')
const selectedAtom = atom({ plugin: 'plan-review', key: 'selectedAgent' } as const, null)

const PANE = 'plan-review'


const ICON: Record<TaskStatus, string> = {
  todo: '○',
  running: '◐',
  review: '◆',
  changes: '✎',
  done: '●',
}
const COLOR: Record<TaskStatus, string> = {
  todo: 'inactive',
  running: 'warning',
  review: 'permission',
  changes: 'error',
  done: 'success',
}

// Draft of the review comment (module variable: safe to lose)
let draft = ''

// ---------------------------------------------------------------------------
// Plan persistence across sessions, per working directory
// ---------------------------------------------------------------------------
async function storeKey($: EngineInterface) {
  return 'plan:' + (await $.session.cwd())
}

async function savePlan($: EngineInterface, plan: Plan | null) {
  const key = await storeKey($)
  if (plan) await $.store.set(key, plan)
  else await $.store.delete(key)
}

async function setPlan($: EngineInterface, fn: (p: Plan | null) => Plan | null) {
  let next: Plan | null = null
  await update($, planAtom, p => (next = fn(p)))
  await savePlan($, next)
  return next as Plan | null
}

async function setTask($: EngineInterface, id: string, patch: Partial<Task>) {
  return setPlan($, p =>
    p ? { ...p, tasks: p.tasks.map(t => (t.id === id ? { ...t, ...patch } : t)) } : p,
  )
}

async function loadPlan($: EngineInterface) {
  const saved = (await $.store.get(await storeKey($))) as Plan | undefined
  if (!saved) return
  await update($, planAtom, () => saved)
  // A review pending when the session closed shows up again
  const pending = saved.tasks.find(t => t.status === 'review')
  if (pending?.summary) {
    await update($, reviewAtom, () => ({ kind: 'task', taskId: pending.id, summary: pending.summary!, files: [] }))
  }
}

function currentTask(plan: Plan | null) {
  return plan?.tasks.find(t => t.status === 'running' || t.status === 'changes')
}

// ---------------------------------------------------------------------------
// Progress bar: one segment per task, colored by its status
// ---------------------------------------------------------------------------
type Run = { text: string; color: string; dim?: boolean }

// Advances on each clock tick to animate the running task and the review
let frame = 0

const SEG_COLOR: Record<TaskStatus, string> = {
  done: 'success',
  running: 'warning',
  review: 'permission',
  changes: 'error',
  todo: 'inactive',
}

function segments(plan: Plan, width: number): Run[] {
  const n = plan.tasks.length
  if (n === 0) return []
  // A thin separator between segments, unless space is short
  const sep = Math.floor((width - (n - 1)) / n) >= 2
  const per = Math.max(1, Math.floor((width - (sep ? n - 1 : 0)) / n))
  const runs: Run[] = []
  plan.tasks.forEach((t, i) => {
    if (i > 0 && sep) runs.push({ text: ' ', color: 'inactive' })
    let text: string
    switch (t.status) {
      case 'done':
        text = '━'.repeat(per)
        break
      case 'running': {
        // A highlight sweeping across the segment
        const pos = frame % (per + 3)
        text = Array.from({ length: per }, (_, k) => (Math.abs(k - pos) <= 1 ? '━' : '╍')).join('')
        break
      }
      case 'review':
        // Slow pulse to catch the eye
        text = (frame % 4 < 2 ? '━' : '╍').repeat(per)
        break
      case 'changes':
        text = '╍'.repeat(per)
        break
      default:
        text = '─'.repeat(per)
    }
    runs.push({ text, color: SEG_COLOR[t.status], dim: t.status === 'todo' })
  })
  return runs
}

function percent(plan: Plan) {
  const done = plan.tasks.filter(t => t.status === 'done').length
  return plan.tasks.length ? Math.round((done / plan.tasks.length) * 100) : 0
}

function isAnimated(plan: Plan | null) {
  return !!plan?.tasks.some(t => t.status === 'running' || t.status === 'review')
}

/** A readable line for a tool call: the file, command or pattern it targets */
function describeCall(e: Record<string, unknown>) {
  const pick = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined)
  const raw =
    pick('file_path') ??
    pick('command') ??
    (pick('pattern') ? pick('pattern') + (pick('path') ? ' in ' + pick('path') : '') : undefined) ??
    pick('path') ??
    pick('url') ??
    pick('query') ??
    pick('description') ??
    ''
  return raw.replace(/\s+/g, ' ').slice(0, 160)
}

const MAX_STEPS = 60

function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// Review decisions: they resume the orchestrator, except the final approval, which closes the tracker
// ---------------------------------------------------------------------------
async function approve($: EngineInterface) {
  const review = await read($, reviewAtom)
  if (!review) return
  const note = draft.trim()
  draft = ''
  if (review.kind === 'plan') return closePlan($)
  await setTask($, review.taskId, { status: 'done', feedback: note || undefined })
  await update($, reviewAtom, () => null)
  await update($, tabAtom, () => 'plan')
  const plan = await read($, planAtom)
  const next = plan?.tasks.find(t => t.status === 'todo')
  const text =
    `✅ Task ${review.taskId} approved.` +
    (note ? ` Note to take into account going forward: ${note}` : '') +
    (next
      ? ` Move on to task ${next.id} (${next.title}).`
      : ' That was the last task of the plan: call plan_review with the final summary of the whole plan.')
  // Don't await: submit waits for the session to be idle
  void $.prompt.submit({ text, asUser: true }).catch(() => {})
}

// Final review approved: the tracker closes without resuming Claude
async function closePlan($: EngineInterface) {
  await setPlan($, () => null)
  await update($, reviewAtom, () => null)
  await update($, agentsAtom, () => [])
  await update($, tabAtom, () => 'plan')
  $.ui.toast('Plan complete ✅')
  void $.ui.close({ id: PANE }).catch(() => {})
}

async function requestChanges($: EngineInterface) {
  const review = await read($, reviewAtom)
  const comment = draft.trim()
  if (!review) return
  if (!comment) {
    $.ui.toast('Write your comment in the field before requesting changes.')
    return
  }
  draft = ''
  if (review.kind === 'task') await setTask($, review.taskId, { status: 'changes', feedback: comment })
  await update($, reviewAtom, () => null)
  await update($, tabAtom, () => 'plan')
  void $.prompt.submit({
    text:
      review.kind === 'plan'
        ? `✏️ Changes requested on the plan: ${comment}\n` +
          `Fix it (yourself or via a subagent), then call plan_review again with the updated summary.`
        : `✏️ Changes requested on task ${review.taskId}: ${comment}\n` +
          `Fix it (yourself or via a subagent), then call task_review again for this same task.`,
    asUser: true,
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadPlan($)

    await $.tool.register({
      name: 'plan_set',
      isDeferred: false,
      description:
        'Declares (or replaces) the current plan in the plan-review visual tracker. Call it once at the start of ' +
        'a multi-task plan, with short ids (T1, T2…) and one-line titles.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' } },
              required: ['id', 'title'],
            },
          },
        },
        required: ['title', 'tasks'],
      },
    })
    await $.tool.register({
      name: 'task_start',
      isDeferred: false,
      description:
        'Marks a plan task as started. Call it before launching the subagent(s) for that task. ' +
        'Refused while a review is pending.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    })
    await $.tool.register({
      name: 'task_review',
      isDeferred: false,
      description:
        "Submits a finished task for the user's review, in a dedicated view. summary: a concise markdown " +
        'summary of what was done and why (not a transcript). After this call, END YOUR TURN without doing ' +
        'anything else: the decision (approval or comments) will arrive as a new message.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          summary: { type: 'string', description: 'Markdown summary: what was done, notable choices' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          tests: { type: 'string', description: 'Tests added/run and their result' },
          concerns: { type: 'string', description: 'Points of attention, doubts, debt introduced' },
        },
        required: ['taskId', 'summary'],
      },
    })
    await $.tool.register({
      name: 'plan_review',
      isDeferred: false,
      description:
        "Submits the whole plan for the user's final review, once every task is approved. summary: " +
        'markdown summary of the plan. After this call, END YOUR TURN: if the user approves, the tracker closes; ' +
        'otherwise their comments will arrive as a new message.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Markdown summary of the whole plan' },
          concerns: { type: 'string', description: 'Points of attention, doubts, remaining debt' },
        },
        required: ['summary'],
      },
    })

    await $.command.register({ name: 'plan-review', description: 'Open or close the plan and review tracker', immediate: true })
    await $.command.register({ name: 'plan-reset', description: 'Clear the tracked plan for this folder' })

    // Animates the bar (and refreshes agent durations) while something is going on
    $.clock.every(250, async () => {
      const agents = await read($, agentsAtom)
      const plan = await read($, planAtom)
      if (!isAnimated(plan) && !agents.some(a => a.status === 'running')) return
      frame += 1
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // /clear, /resume and /branch reset $.state: reload the plan
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadPlan($)
    return next(e)
  })

  // Tells the orchestrator the protocol
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return {
      ...r,
      sections: [
        ...r.sections,
        {
          id: 'plan-review:protocol',
          scope: 'session',
          text:
            'Plan tracking (plan-review mod): when you execute a multi-task plan, especially with ' +
            'subagents and a review between tasks, call mcp__plan-review__plan_set at the start, ' +
            'mcp__plan-review__task_start before each task, and at the end of each task ' +
            'mcp__plan-review__task_review instead of asking for approval in the chat. After task_review, ' +
            'stop: the user approves or comments from the dedicated view. At the end of the plan, once the ' +
            'last task is approved, call mcp__plan-review__plan_review with the final summary, then ' +
            'stop the same way.',
        },
      ],
    }
  })

  // ---------------- Tools Claude calls ----------------
  on('tool.call', { tool: 'mcp__plan-review__plan_set' }, async ($, e) => {
    const input = e as unknown as { title: string; tasks: { id: string; title: string }[] }
    await setPlan($, () => ({
      title: input.title,
      tasks: input.tasks.map(t => ({ id: t.id, title: t.title, status: 'todo' as const })),
    }))
    await update($, reviewAtom, () => null)
    await update($, agentsAtom, () => [])
    void $.ui.open({ id: PANE, title: 'Plan' }).catch(() => {})
    return { result: `Plan saved (${input.tasks.length} tasks). The user can see the tracker.` }
  })

  on('tool.call', { tool: 'mcp__plan-review__task_start' }, async ($, e) => {
    const { taskId } = e as unknown as { taskId: string }
    const plan = await read($, planAtom)
    if (!plan?.tasks.some(t => t.id === taskId)) {
      return { result: `Unknown task: ${taskId}. Call plan_set first.` }
    }
    await setTask($, taskId, { status: 'running' })
    return { result: `Task ${taskId} started.` }
  })

  on('tool.call', { tool: 'mcp__plan-review__task_review' }, async ($, e) => {
    const input = e as unknown as {
      taskId: string
      summary: string
      filesChanged?: string[]
      tests?: string
      concerns?: string
    }
    const review: Review = {
      kind: 'task',
      taskId: input.taskId,
      summary: input.summary,
      files: input.filesChanged ?? [],
      tests: input.tests,
      concerns: input.concerns,
    }
    await update($, reviewAtom, () => review)
    await update($, tabAtom, () => 'review')
    await setTask($, input.taskId, { status: 'review', summary: input.summary })
    $.ui.toast(`Task ${input.taskId} ready for review`)
    void $.ui.open({ id: PANE, title: 'Plan', focus: true }).catch(() => {})
    return {
      result:
        'Review submitted. End your turn now, without starting the next task or editing any file: ' +
        "the user's decision will arrive in a new message.",
    }
  })

  on('tool.call', { tool: 'mcp__plan-review__plan_review' }, async ($, e) => {
    const input = e as unknown as { summary: string; concerns?: string }
    const plan = await read($, planAtom)
    if (!plan) return { result: 'No plan tracked. Call plan_set first.' }
    const left = plan.tasks.filter(t => t.status !== 'done')
    if (left.length) {
      return {
        result:
          'Final review refused: every task must be approved. Remaining: ' +
          left.map(t => `${t.id} (${t.title})`).join(', ') + '.',
      }
    }
    await update($, reviewAtom, () => ({ kind: 'plan', summary: input.summary, files: [], concerns: input.concerns }))
    await update($, tabAtom, () => 'review')
    $.ui.toast('Plan ready for final review')
    void $.ui.open({ id: PANE, title: 'Plan', focus: true }).catch(() => {})
    return {
      result:
        'Final review submitted. End your turn now, without editing any file: ' +
        "the user's decision will arrive in a new message, or the tracker will close.",
    }
  })

  // ---------------- Review gate: blocks the orchestrator ----------------
  on('tool.call', { tool: ['Agent', 'Edit', 'Write', 'NotebookEdit', 'mcp__plan-review__task_start'] }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const review = await read($, reviewAtom)
    if (!review) return next(e)
    return {
      deny:
        (review.kind === 'plan' ? 'The plan' : `Task ${review.taskId}`) +
        " is awaiting the user's review. Don't go further: end your turn, " +
        'the decision will arrive in a new message.',
    }
  })

  // ---------------- Subagent tracking ----------------
  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (!res.agentId) return res
    const plan = await read($, planAtom)
    const run: AgentRun = {
      id: res.agentId,
      description: e.description || e.subagentType,
      type: e.subagentType,
      taskId: currentTask(plan)?.id,
      status: 'running',
      tools: 0,
      startedAt: await $.clock.now(),
      prompt: e.prompt.slice(0, 4000),
      log: [],
    }
    await update($, agentsAtom, list => [...list, run].slice(-50))
    return res
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) return next(e)
    const id = e.agentId
    const detail = describeCall(e as unknown as Record<string, unknown>)
    let n = 0
    await update($, agentsAtom, list =>
      list.map(a => {
        if (a.id !== id) return a
        n = a.tools + 1
        const step: AgentStep = { n, tool: e.tool, detail, state: 'running' }
        return { ...a, tools: n, lastTool: e.tool, log: [...(a.log ?? []), step].slice(-MAX_STEPS) }
      }),
    )
    const result = await next(e)
    const r = result as { deny?: string; isError?: boolean }
    const state: AgentStep['state'] = r.deny ? 'denied' : r.isError ? 'error' : 'ok'
    await update($, agentsAtom, list =>
      list.map(a =>
        a.id === id && a.log ? { ...a, log: a.log.map(s => (s.n === n ? { ...s, state } : s)) } : a,
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const now = await $.clock.now()
      await update($, agentsAtom, list =>
        list.map(a =>
          a.id === id
            ? {
                ...a,
                status: e.reason === 'answer' ? 'done' : 'error',
                endedAt: now,
                answer: e.answer.slice(0, 8000),
              }
            : a,
        ),
      )
    }
    return next(e)
  })

  // ---------------- Commands ----------------
  // Toggle: closes the pane if it is shown, otherwise opens it (or brings it to the front)
  on('command.run', { command: 'plan-review' }, async $ => {
    const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)
    if (shown) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'Plan', focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'plan-reset' }, async $ => {
    await setPlan($, () => null)
    await update($, reviewAtom, () => null)
    await update($, agentsAtom, () => [])
    return { text: 'Plan cleared.' }
  })

  // ---------------- Band above the prompt ----------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const plan = await read($, planAtom)
    if (!plan || e.props.hasSurvey) return next(e)
    const review = await read($, reviewAtom)
    const agents = await read($, agentsAtom)
    const { Box, Text, Button } = $.ui.resolve(e)

    const done = plan.tasks.filter(t => t.status === 'done').length
    const total = plan.tasks.length
    const cur = currentTask(plan)
    const running = agents.filter(a => a.status === 'running').length

    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexDirection="row">
          {segments(plan, Math.min(24, Math.max(8, total * 4))).map(r => (
            <Text color={r.color} dimColor={r.dim}>
              {r.text}
            </Text>
          ))}
        </Box>
        <Text bold color={done === total ? 'success' : undefined}>
          {done === total ? '✔ ' : ''}
          {percent(plan)}%
        </Text>
        {review ? (
          <Text color="permission" bold>
            ◆ {review.kind === 'plan' ? 'the plan' : review.taskId} awaits your review
          </Text>
        ) : cur ? (
          <Text wrap="truncate">
            {ICON[cur.status]} {cur.id} {cur.title}
          </Text>
        ) : (
          <Text dimColor>{done === total ? 'plan complete' : 'waiting'}</Text>
        )}
        {running > 0 && <Text color="warning">· {running} agent(s)</Text>}
        <Button
          key="open"
          label={review ? 'Review' : 'Plan'}
          hotkey="0"
          plain
          onPress={async () => {
            if (review) await update($, tabAtom, () => 'review')
            await $.ui.open({ id: PANE, title: 'Plan', focus: true, closeOnEscape: true })
          }}
        />
      </Box>
    )
  })

  // ---------------- Pane ----------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    const Input = 'Input' in els ? els.Input : undefined
    const plan = await read($, planAtom)
    const review = await read($, reviewAtom)
    const agents = await read($, agentsAtom)
    const tab = await read($, tabAtom)
    const now = await $.clock.now()
    const selectedId = await read($, selectedAtom)
    const agentColor = (st: AgentRun['status']) => (st === 'running' ? 'warning' : st === 'done' ? 'success' : 'error')
    const agentIcon = (st: AgentRun['status']) => (st === 'running' ? '◐' : st === 'done' ? '●' : '✕')
    const STEP: Record<AgentStep['state'], [string, string]> = {
      running: ['◐', 'warning'],
      ok: ['✓', 'success'],
      error: ['✕', 'error'],
      denied: ['⊘', 'error'],
    }

    // Subagent detail view: instructions, activity, report
    const agentDetail = (a: AgentRun) => {
      const steps = (a.log ?? []).slice(-25)
      const hidden = (a.log?.length ?? 0) - steps.length + Math.max(0, a.tools - (a.log?.length ?? 0))
      return (
        <Box flexDirection="column">
          <Button key="back" label="← Agents" hotkey="b" plain onPress={() => update($, selectedAtom, () => null)} />
          <Text> </Text>
          <Box flexDirection="row" columnGap={1}>
            <Text color={agentColor(a.status)}>{agentIcon(a.status)}</Text>
            <Text bold wrap="truncate">
              {a.taskId ? a.taskId + ' · ' : ''}
              {a.description}
            </Text>
          </Box>
          <Text dimColor wrap="truncate">
            {'  '}
            {a.type} · {a.tools} tool calls · {elapsed((a.endedAt ?? now) - a.startedAt)}
            {a.status === 'running' ? ' · running' : a.status === 'done' ? ' · done' : ' · interrupted'}
          </Text>
          {a.prompt && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Instructions</Text>
              <Markdown text={a.prompt.length > 700 ? a.prompt.slice(0, 700) + ' …' : a.prompt} dimColor />
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Activity</Text>
            {steps.length === 0 && <Text dimColor>No tool calls yet.</Text>}
            {hidden > 0 && <Text dimColor>  … {hidden} older calls</Text>}
            {steps.map(st => (
              <Box flexDirection="row" columnGap={1}>
                <Text color={STEP[st.state][1]}>{STEP[st.state][0]}</Text>
                <Text bold>{st.tool.replace(/^mcp__[^_]+__/, '')}</Text>
                <Text dimColor wrap="truncate-middle">
                  {st.detail}
                </Text>
              </Box>
            ))}
          </Box>
          {a.answer && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Report</Text>
              <Markdown text={a.answer} />
            </Box>
          )}
        </Box>
      )
    }
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 2)

    const tabBtn = (id: Tab, label: string, hotkey: string) => (
      <Button
        key={'tab-' + id}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={tab !== id}
        onPress={async () => {
          if (id === 'agents' && tab === 'agents') await update($, selectedAtom, () => null)
          await update($, tabAtom, () => id)
        }}
      />
    )

    const running = agents.filter(a => a.status === 'running').length
    const header = (
      <Box flexDirection="row" columnGap={3}>
        {tabBtn('plan', 'Plan', '1')}
        {tabBtn('agents', running ? `Agents (${running})` : 'Agents', '2')}
        {tabBtn('review', review ? 'Review ◆' : 'Review', '3')}
      </Box>
    )

    let body
    if (!plan) {
      body = (
        <Text dimColor>
          No plan tracked. Ask Claude to execute a plan with a review between each task: it will declare it here.
        </Text>
      )
    } else if (tab === 'plan') {
      const done = plan.tasks.filter(t => t.status === 'done').length
      body = (
        <Box flexDirection="column">
          <Text bold wrap="truncate">
            {plan.title}
          </Text>
          <Box flexDirection="row" columnGap={1}>
            <Box flexDirection="row">
              {segments(plan, Math.min(48, width - 14)).map(r => (
                <Text color={r.color} dimColor={r.dim}>
                  {r.text}
                </Text>
              ))}
            </Box>
            <Text bold color={done === plan.tasks.length ? 'success' : undefined}>
              {percent(plan)}%
            </Text>
            <Text dimColor>
              {done}/{plan.tasks.length}
            </Text>
          </Box>
          <Text> </Text>
          {plan.tasks.map(t => {
            const n = agents.filter(a => a.taskId === t.id).length
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Text color={COLOR[t.status]}>{ICON[t.status]}</Text>
                  <Text bold={t.status === 'running' || t.status === 'review'} dimColor={t.status === 'done'} wrap="truncate">
                    {t.id} {t.title}
                    {n ? `  (${n} agent${n > 1 ? 's' : ''})` : ''}
                  </Text>
                </Box>
                {t.feedback && (
                  <Text dimColor italic wrap="truncate">
                    {'   ↳ '}
                    {t.feedback}
                  </Text>
                )}
              </Box>
            )
          })}
          <Text> </Text>
          <Text dimColor>○ to do ◐ running ◆ in review ✎ to fix ● approved</Text>
        </Box>
      )
    } else if (tab === 'agents') {
      const selected = agents.find(a => a.id === selectedId)
      body = selected ? (
        agentDetail(selected)
      ) : agents.length === 0 ? (
        <Text dimColor>No subagents launched yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>Click an agent, or Tab then Enter, to see its details.</Text>
          <Text> </Text>
          {[...agents].reverse().map(a => (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text color={agentColor(a.status)}>{agentIcon(a.status)}</Text>
                <Button
                  key={'agent-' + a.id}
                  label={(a.taskId ? a.taskId + ' · ' : '') + a.description}
                  plain
                  onPress={() => update($, selectedAtom, () => a.id)}
                />
              </Box>
              <Text dimColor wrap="truncate">
                {'  '}
                {a.type} · {a.tools} tool calls · {elapsed((a.endedAt ?? now) - a.startedAt)}
                {a.status === 'running' && a.lastTool ? ' · ' + a.lastTool : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )
    } else if (!review) {
      body = <Text dimColor>No review pending.</Text>
    } else {
      const title =
        review.kind === 'plan'
          ? `Final review: ${plan.title}`
          : `${review.taskId} ${plan.tasks.find(t => t.id === review.taskId)?.title ?? ''}`
      const md =
        review.summary +
        (review.files.length ? '\n\n**Files changed**\n' + review.files.map(f => '- `' + f + '`').join('\n') : '') +
        (review.tests ? '\n\n**Tests** — ' + review.tests : '') +
        (review.concerns ? '\n\n**Points of attention** — ' + review.concerns : '')
      body = (
        <Box flexDirection="column">
          <Text bold color="permission" wrap="truncate">
            ◆ {title}
          </Text>
          <Text> </Text>
          <Markdown text={md.slice(0, 10000)} />
          <Text> </Text>
          {Input && (
          <Input
            key="comment"
            label="Comment"
            placeholder="optional to approve, required to request changes"
            value={draft}
            submitLabel="request changes"
            onInput={(value: string) => {
              draft = value
            }}
            onSubmit={(value: string) => {
              draft = value
              return requestChanges($)
            }}
          />
          )}
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            <Button
              key="approve"
              label={review.kind === 'plan' ? 'Approve and close the plan' : 'Approve and continue'}
              hotkey="v" autoFocus onPress={() => approve($)} />
            <Button key="changes" label="Request changes" hotkey="c" onPress={() => requestChanges($)} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        {body}
      </Box>
    )
  })
}
