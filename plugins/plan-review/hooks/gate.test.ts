import { expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Plan', isFocused: true, bodyColumns: 80, placement: 'dock' }, requestId: 'plan-review' } as const

test('a pending review blocks the orchestrator, approval resumes the rest', async ($, on) => {
  const submitted: string[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  // what Claude Code would draw without the mod
  on('ui.render', async () => null as never)
  on('tool.call', async () => ({ result: 'ran' }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push((e as { text: string }).text)
    return { text: (e as { text: string }).text } as never
  })

  await $.tool.call({
    tool: 'mcp__plan-review__plan_set',
    title: 'Subscription refactor',
    tasks: [
      { id: 'T1', title: 'Extract the port' },
      { id: 'T2', title: 'JPA adapter' },
    ],
  } as never)
  await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T1' } as never)
  await $.tool.call({
    tool: 'mcp__plan-review__task_review',
    taskId: 'T1',
    summary: '`SubscriptionRepository` port extracted, characterization tests green.',
  } as never)

  // The orchestrator can no longer launch a subagent or edit
  const blocked = await $.tool.call({ tool: 'Agent', prompt: 'T2', description: 'T2' } as never)
  expect(JSON.stringify(blocked)).toContain('awaiting the user')

  // A subagent is not blocked by the gate
  // (the review view shows the summary and the Approve button)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-review', surface, ...PANE } as never)
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('T1 approved')
  expect(submitted[0]).toContain('T2')

  // Gate lifted
  const after = await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T2' } as never)
  expect(JSON.stringify(after)).toContain('T2 started')
})

test('requesting changes requires a comment and forwards it', async ($, on) => {
  const submitted: string[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  // what Claude Code would draw without the mod
  on('ui.render', async () => null as never)
  on('tool.call', async () => ({ result: 'ran' }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push((e as { text: string }).text)
    return { text: (e as { text: string }).text } as never
  })
  await $.tool.call({ tool: 'mcp__plan-review__plan_set', title: 'P', tasks: [{ id: 'T1', title: 'A' }] } as never)
  await $.tool.call({ tool: 'mcp__plan-review__task_review', taskId: 'T1', summary: 'fait' } as never)

  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'changes' })
  expect(submitted.length).toBe(0)

  await (ui as unknown as { input: (a: { key: string; text: string }) => Promise<void> }).input({ key: 'comment', text: 'Name the port after the domain language' })
  await ui.unmount()
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Name the port')
})
