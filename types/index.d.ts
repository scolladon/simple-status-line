export type LimitWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Slice = { label: string; tokens: number; color: string }

export type ContextView = {
  slices: Slice[]
  used: number
  max: number
  autoAt: number | null
}

export type CacheView = { hitPercent: number | null; sentAt: number | null; isWarming: boolean }

export type ActionKind = 'read' | 'write' | 'command'

export type Action = { kind: ActionKind; text: string }

export type AgentView = {
  id: string
  name: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
}

export type TaskItem = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type WorkspaceView = {
  path: string
  repo: string | null
  branch: string | null
  ahead: number
  behind: number
  changed: number
  worktree: string | null
}

export type Failure = {
  tool: string
  target: string | null
  isDenied: boolean
  exitCode: number | null
  message: string
}

export type PulseView = {
  startedAt: number | null
  endedAt: number | null
  tools: number
  files: string[]
  outTokens: number
  errors: number
  lastFailure: Failure | null
}

declare module 'claude-code' {
  interface PluginState {
    'simple-status-line': {
      limits: LimitWindow[]
      context: ContextView | null
      cache: CacheView
      now: number
      tasks: TaskItem[]
      actions: Record<string, Action>
      agents: AgentView[]
      workspace: WorkspaceView | null
      pulse: PulseView
      cost: number | null
    }
  }
}
