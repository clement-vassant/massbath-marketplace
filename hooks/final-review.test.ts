import { expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Plan', isFocused: true, bodyColumns: 80, placement: 'dock' }, requestId: 'plan-review' } as const
const ABOVE = { component: 'AbovePrompt', props: { hasSurvey: false } } as const

function flat(el: unknown): string {
  if (typeof el === 'string') return el
  const node = el as { props?: { children?: unknown; text?: string; label?: string }; children?: unknown }
  const own = (node?.props?.text ?? '') + (node?.props?.label ?? '')
  const c = node?.props?.children ?? node?.children ?? []
  return own + (Array.isArray(c) ? c : [c]).map(flat).join('')
}

type Harness = { submitted: string[]; closed: string[]; toasts: string[]; saved: Map<string, unknown> }

// Ce que Claude Code ferait sans le mod, puis un plan de deux tâches
async function setup($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  const h: Harness = { submitted: [], closed: [], toasts: [], saved: new Map() }
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  // Un store en mémoire que le test peut inspecter
  on('store.get', async (_$, e) => ({ value: h.saved.get(e.key) }) as never)
  on('store.set', async (_$, e) => ({ value: void h.saved.set(e.key, e.value) }) as never)
  on('store.delete', async (_$, e) => ({ value: void h.saved.delete(e.key) }) as never)
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async (_$, e) => {
    h.closed.push((e as { id: string }).id)
    return { value: undefined } as never
  })
  on('ui.toast', async (_$, e) => {
    h.toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, async (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return (Text as unknown as (p: object) => never)({ children: 'bandeau natif' })
  })
  on('ui.render', async () => null as never)
  on('tool.call', async () => ({ result: 'ran' }) as never)
  on('prompt.submit', async (_$, e) => {
    h.submitted.push((e as { text: string }).text)
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
  return h
}

async function validateTask($: Parameters<Parameters<typeof test>[1]>[0], taskId: string) {
  await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId } as never)
  await $.tool.call({ tool: 'mcp__plan-review__task_review', taskId, summary: 'fait' } as never)
  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()
}

test('plan_review est refusé tant qu’une tâche n’est pas validée', async ($, on) => {
  await setup($, on)
  await validateTask($, 'T1')

  const refused = await $.tool.call({ tool: 'mcp__plan-review__plan_review', summary: 'bilan' } as never)
  expect(JSON.stringify(refused)).toContain('T2')
  // Aucune revue créée : la porte reste ouverte
  const after = await $.tool.call({ tool: 'mcp__plan-review__task_start', taskId: 'T2' } as never)
  expect(JSON.stringify(after)).toContain('T2 démarrée')
})

test('la validation de la dernière tâche demande plan_review', async ($, on) => {
  const h = await setup($, on)
  await validateTask($, 'T1')
  await validateTask($, 'T2')

  expect(h.submitted.length).toBe(2)
  expect(h.submitted[1]).toContain('T2 validée')
  expect(h.submitted[1]).toContain('plan_review')
})

test('valider la revue finale referme le suivi sans relancer Claude', async ($, on) => {
  const h = await setup($, on)
  await validateTask($, 'T1')
  await validateTask($, 'T2')

  const res = await $.tool.call({
    tool: 'mcp__plan-review__plan_review',
    summary: 'Port extrait et **adapté** à JPA.',
  } as never)
  expect(JSON.stringify(res)).toContain('Revue finale soumise')

  // La porte de revue s'applique pendant l'attente
  const blocked = await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
  expect(JSON.stringify(blocked)).toContain('deny')

  // La vue dit qu'il s'agit de la revue finale du plan
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-review', surface, ...PANE } as never)
    const drawn = flat(await ui.drawn())
    expect(drawn).toContain('Revue finale')
    expect(drawn).toContain('Refacto souscription')
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()

  expect(h.submitted.length).toBe(2) // rien de plus que les deux validations de tâches
  expect(h.closed).toContain('plan-review')
  expect(h.toasts.join()).toContain('Plan terminé')
  expect(h.saved.has('plan:/repo')).toBe(false)

  // Plus de plan : le bandeau se rabat sur ce que Claude Code dessinerait
  const band = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...ABOVE } as never)
  expect(flat(await band.drawn())).toBe('bandeau natif')
  await band.unmount()

  // Porte levée
  const edit = await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
  expect(JSON.stringify(edit)).toContain('ran')
})

test('demander des changements sur la revue finale garde le plan et transmet le commentaire', async ($, on) => {
  const h = await setup($, on)
  await validateTask($, 'T1')
  await validateTask($, 'T2')
  await $.tool.call({ tool: 'mcp__plan-review__plan_review', summary: 'bilan' } as never)

  const ui = await $.ui.mount({ plugin: 'plan-review', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'changes' })
  expect(h.submitted.length).toBe(2)

  await (ui as unknown as { input: (a: { key: string; text: string }) => Promise<void> }).input({ key: 'comment', text: 'Documenter le port' })
  await ui.unmount()

  expect(h.submitted.length).toBe(3)
  expect(h.submitted[2]).toContain('Documenter le port')
  expect(h.submitted[2]).toContain('plan_review')
  expect(h.closed).not.toContain('plan-review')
  expect(h.saved.has('plan:/repo')).toBe(true)
})
