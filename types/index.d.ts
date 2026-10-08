export type TaskStatus = 'todo' | 'running' | 'review' | 'changes' | 'done'

export type Task = {
  id: string
  title: string
  status: TaskStatus
  summary?: string
  feedback?: string
}

export type Plan = { title: string; tasks: Task[] }

export type Review = {
  taskId: string
  summary: string
  files: string[]
  tests?: string
  concerns?: string
}

export type AgentRun = {
  id: string
  description: string
  type: string
  taskId?: string
  status: 'running' | 'done' | 'error'
  tools: number
  lastTool?: string
  startedAt: number
  endedAt?: number
  answer?: string
  /** Consigne donnée au sous-agent */
  prompt?: string
  /** Journal de ses appels d'outils, les plus récents à la fin */
  log?: AgentStep[]
}

export type AgentStep = {
  /** Numéro de l'appel chez cet agent */
  n: number
  tool: string
  detail: string
  state: 'running' | 'ok' | 'error' | 'denied'
}

export type Tab = 'plan' | 'agents' | 'review'

declare module 'claude-code' {
  interface PluginState {
    'plan-review': {
      plan: Plan | null
      review: Review | null
      agents: AgentRun[]
      tab: Tab
      selectedAgent: string | null
    }
  }
}
