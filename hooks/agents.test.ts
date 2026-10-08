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

test('cliquer sur un agent ouvre sa vue détaillée avec son activité et son rapport', async ($, on) => {
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.render', async () => null as never)
  // Ce que Claude Code ferait : démarrer l'agent, exécuter ses outils, clore son tour
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'ag-1' }) as never)
  on('tool.call', async (_$, e) => (e.tool === 'Bash' ? { result: 'BUILD FAILURE', isError: true } : { result: 'ok' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)

  await $.tool.call({ tool: 'mcp__plan-review__plan_set', title: 'P', tasks: [{ id: 'T1', title: 'Port' }] } as never)
  await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T1' } as never)
  await $.agent.spawn({ prompt: 'Extrais le port SubscriptionRepository', description: 'Extraire le port', subagentType: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'src/main/java/Subscription.java', agentId: 'ag-1' } as never)
  await $.tool.call({ tool: 'Bash', command: './mvnw test', agentId: 'ag-1' } as never)
  await $.turn.complete({
    answer: 'Port extrait, **3 tests** ajoutés.',
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
  expect(drawn).toContain('Extrais le port SubscriptionRepository')
  expect(drawn).toContain('src/main/java/Subscription.java')
  expect(drawn).toContain('./mvnw test')
  expect(drawn).toContain('3 tests')
  expect(drawn).toContain('✕')

  // Retour à la liste
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'agent-ag-1' })).toBeDefined()
  await ui.unmount()
})
