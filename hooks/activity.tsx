import { atom, read, update } from 'claude-code'
import type { AgentStatus, Color, Elements, EngineInterface, On } from 'claude-code'

import type { Action, ActionKind, AgentView, TaskItem } from '../types'

const MAIN = 'main'
const MAIN_LABEL = 'main'
const NAME_MAX = 12
const AGENT_REFRESH_MS = 2000
const LIVE: readonly string[] = ['pending', 'running', 'waiting']

const STATUS_GLYPH: Record<AgentStatus, { glyph: string; color: Color }> = {
  running: { glyph: '●', color: 'success' },
  pending: { glyph: '○', color: 'inactive' },
  waiting: { glyph: '◐', color: 'warning' },
  idle: { glyph: '○', color: 'inactive' },
  completed: { glyph: '✓', color: 'inactive' },
  failed: { glyph: '✗', color: 'error' },
  killed: { glyph: '✗', color: 'inactive' },
}
const ACTION_GLYPH: Record<ActionKind, string> = { read: '›', write: '✎', command: '$' }

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type Row = { id: string; name: string; status: AgentStatus; action: Action | undefined }

const tasks = atom({ plugin: 'simple-status-line', key: 'tasks' } as const, [])
const actions = atom({ plugin: 'simple-status-line', key: 'actions' } as const, {})
const agents = atom({ plugin: 'simple-status-line', key: 'agents' } as const, [])

let cwd = ''
let lastAgentRefresh = 0

const relative = (path: string) =>
  cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

async function record($: EngineInterface, agentId: string | undefined, kind: ActionKind, text: string) {
  const action: Action = { kind, text }
  await update($, actions, held => ({ ...held, [agentId ?? MAIN]: action }))
}

async function refreshAgents($: EngineInterface) {
  lastAgentRefresh = await $.clock.now()
  const list = await $.agent.list()
  const views: AgentView[] = list.map(agent => ({ id: agent.id, name: agent.type, status: agent.status }))
  await update($, agents, () => views)
}

export async function pollAgents($: EngineInterface, at: number) {
  const held = await read($, agents)
  const hasLive = held.some(agent => LIVE.includes(agent.status))

  if (hasLive && at - lastAgentRefresh >= AGENT_REFRESH_MS) {
    await refreshAgents($)
  }
}

// This build types TaskCreate's result loosely, so its `{ task: { id } }` shape is checked here.
const createdTaskId = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null || !('task' in result)) {
    return undefined
  }

  const { task } = result

  return typeof task === 'object' && task !== null && 'id' in task && typeof task.id === 'string'
    ? task.id
    : undefined
}

const patchTask = (list: readonly TaskItem[], id: string, patch: Partial<TaskItem>) =>
  list.map(task => (task.id === id ? { ...task, ...patch } : task))

export async function startActivity($: EngineInterface, workingDirectory: string) {
  cwd = workingDirectory
  await refreshAgents($)
}

export const registerActivity = (on: On) => {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    await record($, e.agentId, 'read', relative(e.file_path))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    await record($, e.agentId, 'write', relative(e.file_path))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    await record($, e.agentId, 'write', relative(e.file_path))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await record($, e.agentId, 'command', firstLine(e.command))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const list: TaskItem[] = e.todos.map((todo, index) => ({
      id: String(index),
      subject: todo.content,
      activeForm: todo.activeForm,
      status: todo.status,
    }))
    await update($, tasks, () => list)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = createdTaskId(ran.result)

    if (id !== undefined) {
      const task: TaskItem = { id, subject: e.subject, activeForm: e.activeForm, status: 'pending' }
      await update($, tasks, held => [...held, task])
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    if (e.status === 'deleted') {
      await update($, tasks, held => held.filter(task => task.id !== e.taskId))
    } else {
      const patch: Partial<TaskItem> = {
        ...(e.status === undefined ? {} : { status: e.status }),
        ...(e.subject === undefined ? {} : { subject: e.subject }),
        ...(e.activeForm === undefined ? {} : { activeForm: e.activeForm }),
      }
      await update($, tasks, held => patchTask(held, e.taskId, patch))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStart', async ($, e, next) => {
    await refreshAgents($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await refreshAgents($)

    return result
  }).catch(($, e, next) => next(e))
}

const rowsOf = (views: readonly AgentView[], held: Record<string, Action>, isWorking: boolean): Row[] => {
  const main: Row = { id: MAIN, name: MAIN_LABEL, status: isWorking ? 'running' : 'idle', action: held[MAIN] }
  const others = views.map(view => ({ id: view.id, name: view.name, status: view.status, action: held[view.id] }))
  const live = others.filter(row => LIVE.includes(row.status))
  const done = others.filter(row => !LIVE.includes(row.status)).reverse()

  return [main, ...live, ...done]
}

const taskRow = ({ Box, Text }: Tags, list: readonly TaskItem[], isDim: boolean) => {
  if (list.length === 0) {
    return (
      <Box key="task">
        <Text dimColor>▸ no task</Text>
      </Box>
    )
  }

  const current = list.find(task => task.status === 'in_progress') ?? list.find(task => task.status === 'pending')
  const doneCount = list.filter(task => task.status === 'completed').length
  const title = current === undefined ? 'all done' : (current.activeForm ?? current.subject)

  return (
    <Box key="task" flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexShrink={1}>
        <Text bold={!isDim} dimColor={isDim} wrap="truncate-end">{`▸ ${title}`}</Text>
      </Box>
      <Text dimColor>{`${doneCount}/${list.length}`}</Text>
    </Box>
  )
}

const actionText = ({ Text }: Tags, action: Action | undefined, isDim: boolean) => {
  if (action === undefined) {
    return <Text dimColor>–</Text>
  }

  return (
    <Text dimColor={isDim} wrap={action.kind === 'command' ? 'truncate-end' : 'truncate-start'}>
      {`${ACTION_GLYPH[action.kind]} ${action.text}`}
    </Text>
  )
}

const agentRow = (tags: Tags, row: Row, nameWidth: number, isPaneIdle: boolean) => {
  const { Box, Text } = tags
  const { glyph, color } = STATUS_GLYPH[row.status]
  const isDim = isPaneIdle || !LIVE.includes(row.status) && row.id !== MAIN

  return (
    <Box key={row.id} flexDirection="row" gap={1}>
      <Text color={color}>{glyph}</Text>
      <Box width={nameWidth} flexShrink={0}>
        <Text dimColor={isDim} wrap="truncate-end">{row.name}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        {row.status === 'waiting' ? <Text color="warning">waiting</Text> : actionText(tags, row.action, isDim)}
      </Box>
    </Box>
  )
}

export async function activityPane($: EngineInterface, tags: Tags, isWorking: boolean, height: number) {
  const list = await read($, tasks)
  const rows = rowsOf(await read($, agents), await read($, actions), isWorking)
  const isPaneIdle = !isWorking && !rows.some(row => row.id !== MAIN && LIVE.includes(row.status))
  const slots = Math.max(1, height - 1)
  const isOverflowing = rows.length > slots
  const shown = isOverflowing ? rows.slice(0, slots - 1) : rows
  const nameWidth = Math.min(NAME_MAX, Math.max(...shown.map(row => row.name.length)))

  return (
    <tags.Box flexDirection="column">
      {taskRow(tags, list, isPaneIdle)}
      {shown.map(row => agentRow(tags, row, nameWidth, isPaneIdle))}
      {isOverflowing && <tags.Text key="more" dimColor>{`+${rows.length - shown.length} more`}</tags.Text>}
    </tags.Box>
  )
}
