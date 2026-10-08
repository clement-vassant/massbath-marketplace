export type TaskStatus = 'todo' | 'running' | 'review' | 'changes' | 'done'

export type Task = {
  id: string
  title: string
  status: TaskStatus
  summary?: string
  feedback?: string
}

export type Plan = { title: string; tasks: Task[] }

/** Review of one task, or final review of the whole plan once every task is approved */
export type Review = {
  summary: string
  files: string[]
  tests?: string
  concerns?: string
} & ({ kind: 'task'; taskId: string } | { kind: 'plan' })

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
  /** Instructions given to the subagent */
  prompt?: string
  /** Log of its tool calls, most recent last */
  log?: AgentStep[]
}

export type AgentStep = {
  /** Number of the call within this agent */
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
