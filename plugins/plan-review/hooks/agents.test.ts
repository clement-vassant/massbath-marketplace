import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  props: { title: 'Plan', isFocused: true, bodyColumns: 90, placement: 'dock' },
  requestId: 'plan-review',
} as const

function flat(el: unknown): string {
  if (typeof el === 'string') return el
  const node = el as { props?: { children?: unknown; text?: string; label?: string }; children?: unknown }
  const own = (node?.props?.text ?? '') + (node?.props?.label ?? '')
  const c = node?.props?.children ?? node?.children ?? []
  return own + (Array.isArray(c) ? c : [c]).map(flat).join('')
}

test('clicking an agent opens its detail view with its activity and report', async ($, on) => {
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.render', async () => null as never)
  // What Claude Code would do: start the agent, run its tools, end its turn
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'ag-1' }) as never)
  on('tool.call', async (_$, e) => (e.tool === 'Bash' ? { result: 'BUILD FAILURE', isError: true } : { result: 'ok' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)

  await $.tool.call({ tool: 'mcp__plan-review__plan_set', title: 'P', tasks: [{ id: 'T1', title: 'Port' }] } as never)
  await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T1' } as never)
  await $.agent.spawn({ prompt: 'Extract the SubscriptionRepository port', description: 'Extract the port', subagentType: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'src/main/java/Subscription.java', agentId: 'ag-1' } as never)
  await $.tool.call({ tool: 'Bash', command: './mvnw test', agentId: 'ag-1' } as never)
  await $.turn.complete({
    answer: 'Port extracted, **3 tests** added.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't',
    agentId: 'ag-1',
    reason: 'answer',
  } as never)

  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'tab-agents' })
  await ui.press({ key: 'agent-ag-1' })

  const drawn = flat(await ui.drawn())
  expect(drawn).toContain('Extract the SubscriptionRepository port')
  expect(drawn).toContain('src/main/java/Subscription.java')
  expect(drawn).toContain('./mvnw test')
  expect(drawn).toContain('3 tests')
  expect(drawn).toContain('✕')

  // Back to the list
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'agent-ag-1' })).toBeDefined()
  await ui.unmount()
})
