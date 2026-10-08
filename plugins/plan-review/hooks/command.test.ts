import { expect, mock, test } from 'claude-code/testing'

test('/plan-review opens the pane, then closes it on the second call', async ($, on) => {
  const panes = new Map<string, { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>()
  const calls: string[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  mock.store(on)
  mock.clock(on)
  // What Claude Code would do: keep the list of open panes
  on('ui.open', async (_$, e) => {
    const { id, title } = e as { id: string; title: string }
    calls.push(`open:${id}`)
    panes.set(id, { id, title, isShown: true, isFocused: true, isPlaced: true })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async (_$, e) => {
    const { id } = e as { id: string }
    calls.push(`close:${id}`)
    panes.delete(id)
    return { value: undefined } as never
  })
  on('ui.panes', async () => ({ value: [...panes.values()] }) as never)
  on('ui.render', async () => null as never)

  await $.command.run({ command: 'plan-review' })
  await $.command.run({ command: 'plan-review' })
  await $.command.run({ command: 'plan-review' })

  expect(calls).toEqual(['open:plan-review', 'close:plan-review', 'open:plan-review'])
})
