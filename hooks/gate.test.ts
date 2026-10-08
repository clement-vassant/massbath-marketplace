import { expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Plan', isFocused: true, bodyColumns: 80, placement: 'dock' }, requestId: 'plan-review' } as const

test('une revue en attente bloque l’orchestrateur, la validation relance la suite', async ($, on) => {
  const submitted: string[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  // ce que Claude Code dessinerait sans le mod
  on('ui.render', async () => null as never)
  on('tool.call', async () => ({ result: 'ran' }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push((e as { text: string }).text)
    return { text: (e as { text: string }).text } as never
  })

  await $.tool.call({
    tool: 'mcp__plan-review__plan_set',
    title: 'Refacto souscription',
    tasks: [
      { id: 'T1', title: 'Extraire le port' },
      { id: 'T2', title: 'Adapter JPA' },
    ],
  } as never)
  await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T1' } as never)
  await $.tool.call({
    tool: 'mcp__plan-review__task_review',
    taskId: 'T1',
    summary: 'Port `SubscriptionRepository` extrait, tests de caractérisation verts.',
  } as never)

  // L'orchestrateur ne peut plus lancer de sous-agent ni éditer
  const blocked = await $.tool.call({ tool: 'Agent', prompt: 'T2', description: 'T2' } as never)
  expect(JSON.stringify(blocked)).toContain('attend la revue')

  // Un sous-agent n'est pas bloqué par la porte
  // (la vue de revue montre la synthèse et le bouton Valider)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-review', surface, ...PANE } as never)
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('T1 validée')
  expect(submitted[0]).toContain('T2')

  // Porte levée
  const after = await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T2' } as never)
  expect(JSON.stringify(after)).toContain('T2 démarrée')
})

test('demander des changements exige un commentaire et le transmet', async ($, on) => {
  const submitted: string[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  // ce que Claude Code dessinerait sans le mod
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

  await (ui as unknown as { input: (a: { key: string; text: string }) => Promise<void> }).input({ key: 'comment', text: 'Nommer le port selon le langage métier' })
  await ui.unmount()
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Nommer le port')
})
