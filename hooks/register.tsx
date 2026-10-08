import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { AgentRun, AgentStep, Plan, Review, Tab, Task, TaskStatus } from '../types'

// ---------------------------------------------------------------------------
// État réactif (survit aux rechargements du module, pas à /clear)
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

// Brouillon du commentaire de revue (variable de module : perdable sans dommage)
let draft = ''

// ---------------------------------------------------------------------------
// Persistance du plan entre sessions, par répertoire de travail
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
  // Une revue en attente au moment de la fermeture redevient visible
  const pending = saved.tasks.find(t => t.status === 'review')
  if (pending?.summary) {
    await update($, reviewAtom, () => ({ taskId: pending.id, summary: pending.summary!, files: [] }))
  }
}

function currentTask(plan: Plan | null) {
  return plan?.tasks.find(t => t.status === 'running' || t.status === 'changes')
}

// ---------------------------------------------------------------------------
// Barre de progression : un segment par tâche, coloré selon son statut
// ---------------------------------------------------------------------------
type Run = { text: string; color: string; dim?: boolean }

// Avance à chaque tic d'horloge pour animer la tâche en cours et la revue
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
  // Un fin séparateur entre segments, sauf si la place manque
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
        // Un reflet qui parcourt le segment
        const pos = frame % (per + 3)
        text = Array.from({ length: per }, (_, k) => (Math.abs(k - pos) <= 1 ? '━' : '╍')).join('')
        break
      }
      case 'review':
        // Pulse lent pour attirer l'œil
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

/** Une ligne lisible pour un appel d'outil : le fichier, la commande ou le motif visé */
function describeCall(e: Record<string, unknown>) {
  const pick = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined)
  const raw =
    pick('file_path') ??
    pick('command') ??
    (pick('pattern') ? pick('pattern') + (pick('path') ? ' dans ' + pick('path') : '') : undefined) ??
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
// Décisions de revue : déclenchent un nouveau tour pour l'orchestrateur
// ---------------------------------------------------------------------------
async function approve($: EngineInterface) {
  const review = await read($, reviewAtom)
  if (!review) return
  const note = draft.trim()
  draft = ''
  await setTask($, review.taskId, { status: 'done', feedback: note || undefined })
  await update($, reviewAtom, () => null)
  await update($, tabAtom, () => 'plan')
  const plan = await read($, planAtom)
  const next = plan?.tasks.find(t => t.status === 'todo')
  const text =
    `✅ Tâche ${review.taskId} validée.` +
    (note ? ` Remarque à prendre en compte pour la suite : ${note}` : '') +
    (next ? ` Passe à la tâche ${next.id} (${next.title}).` : ' C’était la dernière tâche du plan : fais un bilan final.')
  // Ne pas attendre : submit attend que la session soit libre
  void $.prompt.submit({ text, asUser: true }).catch(() => {})
}

async function requestChanges($: EngineInterface) {
  const review = await read($, reviewAtom)
  const comment = draft.trim()
  if (!review) return
  if (!comment) {
    $.ui.toast('Écris ton commentaire dans le champ avant de demander des changements.')
    return
  }
  draft = ''
  await setTask($, review.taskId, { status: 'changes', feedback: comment })
  await update($, reviewAtom, () => null)
  await update($, tabAtom, () => 'plan')
  void $.prompt.submit({
    text:
      `✏️ Changements demandés sur la tâche ${review.taskId} : ${comment}\n` +
      `Corrige (toi-même ou via un sous-agent), puis rappelle task_review pour cette même tâche.`,
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
        'Déclare (ou remplace) le plan en cours dans le suivi visuel plan-review. À appeler une fois au début de ' +
        "l'exécution d'un plan multi-tâches, avec des ids courts (T1, T2…) et des titres d'une ligne.",
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
        'Marque une tâche du plan comme démarrée. Appelle-le avant de lancer le ou les sous-agents de cette tâche. ' +
        'Refusé tant qu’une revue est en attente.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    })
    await $.tool.register({
      name: 'task_review',
      isDeferred: false,
      description:
        "Soumet une tâche terminée à la revue de l'utilisateur, dans une vue dédiée. summary : synthèse markdown " +
        'concise de ce qui a été fait et pourquoi (pas de transcript). Après cet appel, TERMINE TON TOUR sans rien ' +
        'faire d’autre : la décision (validation ou commentaires) arrivera comme un nouveau message.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          summary: { type: 'string', description: 'Synthèse markdown : ce qui a été fait, choix notables' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          tests: { type: 'string', description: 'Tests ajoutés/lancés et leur résultat' },
          concerns: { type: 'string', description: 'Points d’attention, doutes, dette introduite' },
        },
        required: ['taskId', 'summary'],
      },
    })

    await $.command.register({ name: 'plan', description: 'Ouvrir le suivi du plan et des revues', immediate: true })
    await $.command.register({ name: 'plan-reset', description: 'Effacer le plan suivi pour ce dossier' })

    // Rafraîchit les durées des sous-agents tant qu'il y en a en cours
    // Anime la barre (et rafraîchit les durées des agents) quand il se passe quelque chose
    $.clock.every(250, async () => {
      const agents = await read($, agentsAtom)
      const plan = await read($, planAtom)
      if (!isAnimated(plan) && !agents.some(a => a.status === 'running')) return
      frame += 1
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // /clear, /resume et /branch remettent $.state à zéro : on recharge le plan
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadPlan($)
    return next(e)
  })

  // Indique le protocole à l'orchestrateur
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
            'Suivi de plan (mod plan-review) : quand tu exécutes un plan en plusieurs tâches, en particulier avec ' +
            'des sous-agents et une revue entre les tâches, appelle mcp__plan-review__plan_set au début, ' +
            'mcp__plan-review__task_start avant chaque tâche, et à la fin de chaque tâche ' +
            'mcp__plan-review__task_review au lieu de demander la validation dans le chat. Après task_review, ' +
            "arrête-toi : l'utilisateur valide ou commente depuis la vue dédiée.",
        },
      ],
    }
  })

  // ---------------- Outils appelés par Claude ----------------
  on('tool.call', { tool: 'mcp__plan-review__plan_set' }, async ($, e) => {
    const input = e as unknown as { title: string; tasks: { id: string; title: string }[] }
    await setPlan($, () => ({
      title: input.title,
      tasks: input.tasks.map(t => ({ id: t.id, title: t.title, status: 'todo' as const })),
    }))
    await update($, reviewAtom, () => null)
    await update($, agentsAtom, () => [])
    void $.ui.open({ id: PANE, title: 'Plan' }).catch(() => {})
    return { result: `Plan enregistré (${input.tasks.length} tâches). Le suivi est visible par l'utilisateur.` }
  })

  on('tool.call', { tool: 'mcp__plan-review__task_start' }, async ($, e) => {
    const { taskId } = e as unknown as { taskId: string }
    const plan = await read($, planAtom)
    if (!plan?.tasks.some(t => t.id === taskId)) {
      return { result: `Tâche inconnue : ${taskId}. Appelle plan_set d'abord.` }
    }
    await setTask($, taskId, { status: 'running' })
    return { result: `Tâche ${taskId} démarrée.` }
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
      taskId: input.taskId,
      summary: input.summary,
      files: input.filesChanged ?? [],
      tests: input.tests,
      concerns: input.concerns,
    }
    await update($, reviewAtom, () => review)
    await update($, tabAtom, () => 'review')
    await setTask($, input.taskId, { status: 'review', summary: input.summary })
    $.ui.toast(`Tâche ${input.taskId} prête pour revue`)
    void $.ui.open({ id: PANE, title: 'Plan', focus: true }).catch(() => {})
    return {
      result:
        'Revue soumise. Termine ton tour maintenant, sans lancer la tâche suivante ni modifier de fichier : ' +
        "la décision de l'utilisateur arrivera dans un nouveau message.",
    }
  })

  // ---------------- Porte de revue : bloque l'orchestrateur ----------------
  on('tool.call', { tool: ['Agent', 'Edit', 'Write', 'NotebookEdit', 'mcp__plan-review__task_start'] }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const review = await read($, reviewAtom)
    if (!review) return next(e)
    return {
      deny:
        `La tâche ${review.taskId} attend la revue de l'utilisateur. N'avance pas : termine ton tour, ` +
        'la décision arrivera dans un nouveau message.',
    }
  })

  // ---------------- Suivi des sous-agents ----------------
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

  // ---------------- Commandes ----------------
  on('command.run', { command: 'plan' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Plan', focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'plan-reset' }, async $ => {
    await setPlan($, () => null)
    await update($, reviewAtom, () => null)
    await update($, agentsAtom, () => [])
    return { text: 'Plan effacé.' }
  })

  // ---------------- Bandeau au-dessus du prompt ----------------
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
            ◆ {review.taskId} attend ta revue
          </Text>
        ) : cur ? (
          <Text wrap="truncate">
            {ICON[cur.status]} {cur.id} {cur.title}
          </Text>
        ) : (
          <Text dimColor>{done === total ? 'plan terminé' : 'en attente'}</Text>
        )}
        {running > 0 && <Text color="warning">· {running} agent(s)</Text>}
        <Button
          key="open"
          label={review ? 'Revoir' : 'Plan'}
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

  // ---------------- Panneau ----------------
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

    // Vue détaillée d'un sous-agent : consigne, activité, rapport
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
            {a.type} · {a.tools} appels d’outils · {elapsed((a.endedAt ?? now) - a.startedAt)}
            {a.status === 'running' ? ' · en cours' : a.status === 'done' ? ' · terminé' : ' · interrompu'}
          </Text>
          {a.prompt && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Consigne</Text>
              <Markdown text={a.prompt.length > 700 ? a.prompt.slice(0, 700) + ' …' : a.prompt} dimColor />
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Activité</Text>
            {steps.length === 0 && <Text dimColor>Aucun appel d’outil pour l’instant.</Text>}
            {hidden > 0 && <Text dimColor>  … {hidden} appels plus anciens</Text>}
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
              <Text bold>Rapport</Text>
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
        {tabBtn('review', review ? 'Revue ◆' : 'Revue', '3')}
      </Box>
    )

    let body
    if (!plan) {
      body = (
        <Text dimColor>
          Aucun plan suivi. Demande à Claude d’exécuter un plan avec revue entre chaque tâche : il le déclarera ici.
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
          <Text dimColor>○ à faire ◐ en cours ◆ en revue ✎ à corriger ● validée</Text>
        </Box>
      )
    } else if (tab === 'agents') {
      const selected = agents.find(a => a.id === selectedId)
      body = selected ? (
        agentDetail(selected)
      ) : agents.length === 0 ? (
        <Text dimColor>Aucun sous-agent lancé pour l’instant.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>Clique sur un agent, ou Tab puis Entrée, pour voir son détail.</Text>
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
                {a.type} · {a.tools} appels d’outils · {elapsed((a.endedAt ?? now) - a.startedAt)}
                {a.status === 'running' && a.lastTool ? ' · ' + a.lastTool : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )
    } else if (!review) {
      body = <Text dimColor>Aucune revue en attente.</Text>
    } else {
      const task = plan.tasks.find(t => t.id === review.taskId)
      const md =
        review.summary +
        (review.files.length ? '\n\n**Fichiers modifiés**\n' + review.files.map(f => '- `' + f + '`').join('\n') : '') +
        (review.tests ? '\n\n**Tests** — ' + review.tests : '') +
        (review.concerns ? '\n\n**Points d’attention** — ' + review.concerns : '')
      body = (
        <Box flexDirection="column">
          <Text bold color="permission" wrap="truncate">
            ◆ {review.taskId} {task?.title ?? ''}
          </Text>
          <Text> </Text>
          <Markdown text={md.slice(0, 10000)} />
          <Text> </Text>
          {Input && (
          <Input
            key="comment"
            label="Commentaire"
            placeholder="optionnel pour valider, requis pour demander des changements"
            value={draft}
            submitLabel="demander des changements"
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
            <Button key="approve" label="Valider et continuer" hotkey="v" autoFocus onPress={() => approve($)} />
            <Button key="changes" label="Demander des changements" hotkey="c" onPress={() => requestChanges($)} />
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
