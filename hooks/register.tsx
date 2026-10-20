import { atom, read, update } from 'claude-code'
import type {
  Color,
  Elements,
  EngineInterface,
  ModelUsage,
  Register,
  SessionContextBreakdown,
  SessionRateLimit,
} from 'claude-code'

import type { CacheView, ContextView, LimitWindow, Slice } from '../types'

import { activityPane, pollAgents, registerActivity, startActivity } from './activity'
import { addOutput, endPulse, pulseRows, readCost, registerPulse, saveCost, startPulse, usd } from './pulse'
import { refreshWorkspace, registerWorkspace, startWorkspace, workspaceRows } from './workspace'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const SHOWN_WINDOWS = ['five_hour', 'seven_day']
const TTL_MS: Record<string, number> = { '1h': HOUR, '5m': 5 * MINUTE }
const LIMITS_KEY = 'limits'
const WARM_PROMPT = 'Reply with the single word OK.'

const LABEL_WIDTH = 9
const MIN_BAR = 8
const PERCENT_WIDTH = 4
const RESET_WIDTH = 6
// Percent, reset and the gaps after the bar and the percent.
const LIMIT_ROW_FIXED = PERCENT_WIDTH + RESET_WIDTH + 2
const LEGEND_SIZE = 5
const SPLIT_MIN_COLUMNS = 100
const PANE_SHARE = 1 / 3
const SEPARATOR_WIDTH = 3
const SEPARATOR = '│'
const MIN_LEFT_ROWS = 3
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FULL = '█'
const EMPTY = '─'
const MARK = '│'
const SQUARE = '■'
const SHORT_LABEL: Record<string, string> = {
  'System prompt': 'system',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'messages',
}

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type ButtonTags = Tags & Pick<Elements['terminal'], 'Button'>
type Stored = { at: number; windows: LimitWindow[] }

const limits = atom({ plugin: 'simple-status-line', key: 'limits' } as const, [])
const context = atom({ plugin: 'simple-status-line', key: 'context' } as const, null)
const cache = atom({ plugin: 'simple-status-line', key: 'cache' } as const, {
  hitPercent: null,
  sentAt: null,
  isWarming: false,
})
const now = atom({ plugin: 'simple-status-line', key: 'now' } as const, 0)

// Module-local on purpose: a reload starts these over, which only costs one missed tick.
let isTurnRunning = false
let isForking = false
let limitsAt = 0

const tokens = (count: number) => {
  if (count < 1000) {
    return String(count)
  }

  return count < 1_000_000 ? `${Math.round(count / 1000)}k` : `${(count / 1_000_000).toFixed(1)}M`
}

const span = (duration: number) => {
  const days = Math.floor(duration / DAY)
  const hours = Math.floor((duration % DAY) / HOUR)
  const minutes = Math.floor((duration % HOUR) / MINUTE)

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : `${Math.max(1, minutes)}m`
}

const warmLeft = (duration: number) =>
  duration >= MINUTE ? `${Math.floor(duration / MINUTE)}m` : `${Math.ceil(duration / SECOND)}s`

const limitTone = (percent: number): Color =>
  percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'success'

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value))

const shortLabel = (name: string) => SHORT_LABEL[name] ?? name.toLowerCase()

const hitOf = (usage: ModelUsage) => {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

  return total > 0 ? (usage.cache_read_input_tokens / total) * 100 : null
}

const toView = (breakdown: SessionContextBreakdown): ContextView => ({
  slices: breakdown.categories
    .filter(row => row.kind === 'used' && row.tokens > 0)
    .map(row => ({ label: shortLabel(row.name), tokens: row.tokens, color: row.color })),
  used: breakdown.totalTokens,
  max: breakdown.rawMaxTokens,
  autoAt: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
})

const effectiveWindow = (window: LimitWindow, at: number): LimitWindow =>
  window.resetsAt !== undefined && Date.parse(window.resetsAt) <= at
    ? { kind: window.kind, percentUsed: 0 }
    : window

const pace = (window: LimitWindow, at: number) => {
  const length = WINDOW_MS[window.kind]

  if (length === undefined || window.resetsAt === undefined) {
    return null
  }

  return clamp(1 - (Date.parse(window.resetsAt) - at) / length, 1)
}

async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const breakdown = usage.context.breakdown
  await update($, context, () => (breakdown === undefined ? null : toView(breakdown)))
}

async function saveLimits($: EngineInterface, list: readonly SessionRateLimit[]) {
  if (list.length === 0) {
    return
  }

  const held = await read($, limits)
  const kept = held.filter(window => !list.some(fresh => fresh.kind === window.kind))
  const windows = [...list, ...kept]
  limitsAt = await $.clock.now()
  await update($, limits, () => windows)
  await $.store.set(LIMITS_KEY, { at: limitsAt, windows })
}

// Another session may have heard fresher figures; an idle one would otherwise show stale limits.
async function adoptStoredLimits($: EngineInterface) {
  const stored = (await $.store.get(LIMITS_KEY)) as Stored | undefined

  if (stored === undefined || stored.at <= limitsAt) {
    return
  }

  limitsAt = stored.at
  await update($, limits, () => stored.windows)
}

async function tick($: EngineInterface, ttlMs: number) {
  const at = await $.clock.now()
  const previous = await read($, now)
  const { sentAt } = await read($, cache)
  const isCountingDown = isTurnRunning || (sentAt !== null && at - sentAt <= ttlMs + 2 * SECOND)
  const isNewMinute = Math.floor(at / MINUTE) !== Math.floor(previous / MINUTE)

  if (isNewMinute) {
    await adoptStoredLimits($)
  }

  await pollAgents($, at)

  if (isCountingDown || isNewMinute) {
    await update($, now, () => at)
  }
}

async function warm($: EngineInterface) {
  const held = await read($, cache)

  if (isTurnRunning || held.isWarming) {
    return
  }

  isForking = true
  await update($, cache, view => ({ ...view, isWarming: true }))

  try {
    const at = await $.clock.now()
    const result = await $.model.fork({ prompt: WARM_PROMPT })

    if (result.isAnswered) {
      await update($, cache, view => ({ ...view, sentAt: at }))
    } else {
      $.ui.toast(`simple-status-line: warm-up not sent (${result.reason})`)
    }
  } finally {
    isForking = false
    await update($, cache, view => ({ ...view, isWarming: false }))
  }
}

const label = ({ Box, Text }: Tags, text: string) => (
  <Box minWidth={LABEL_WIDTH} flexShrink={0}>
    <Text dimColor>{text}</Text>
  </Box>
)

const limitBar = ({ Text }: Tags, percent: number, paceAt: number | null, width: number) => {
  const eighths = Math.round((clamp(percent, 100) / 100) * width * 8)
  const full = Math.floor(eighths / 8)
  const partial = EIGHTHS[eighths % 8] ?? ''
  const emptyCount = width - full - (partial === '' ? 0 : 1)
  const markIndex = paceAt === null ? -1 : Math.min(width - 1, Math.floor(paceAt * width))
  const empties = Array.from({ length: emptyCount }, (_, i) =>
    width - emptyCount + i === markIndex ? MARK : EMPTY,
  ).join('')

  return (
    <Text>
      <Text color={limitTone(percent)}>{FULL.repeat(full) + partial}</Text>
      <Text dimColor>{empties}</Text>
    </Text>
  )
}

const limitRow = (tags: Tags, window: LimitWindow, at: number, width: number) => {
  const { Box, Text } = tags
  const shown = effectiveWindow(window, at)
  const left = shown.resetsAt === undefined ? null : Date.parse(shown.resetsAt) - at
  const barWidth = Math.max(MIN_BAR, width - LABEL_WIDTH - LIMIT_ROW_FIXED)

  return (
    <Box key={window.kind} flexDirection="row" gap={1} width={width}>
      <Box width={LABEL_WIDTH - 1} flexShrink={0}>
        <Text dimColor>{`Limit ${WINDOW_LABEL[window.kind] ?? window.kind}`}</Text>
      </Box>
      {limitBar(tags, shown.percentUsed, pace(shown, at), barWidth)}
      <Box minWidth={PERCENT_WIDTH} justifyContent="flex-end">
        <Text color={limitTone(shown.percentUsed)}>{`${Math.round(shown.percentUsed)}%`}</Text>
      </Box>
      <Box minWidth={RESET_WIDTH} justifyContent="flex-end">
        <Text dimColor>{left === null ? '' : span(left)}</Text>
      </Box>
    </Box>
  )
}

const limitRows = (tags: Tags, list: readonly LimitWindow[], at: number, width: number) =>
  SHOWN_WINDOWS.map(kind => list.find(window => window.kind === kind))
    .filter((window): window is LimitWindow => window !== undefined)
    .map(window => limitRow(tags, window, at, width))

const stackedBar = ({ Text }: Tags, view: ContextView, width: number) => {
  let cumulative = 0
  let drawn = 0
  const pieces = view.slices.map(slice => {
    cumulative += slice.tokens
    const edge = Math.min(width, Math.round((cumulative / view.max) * width))
    const cells = Math.max(0, edge - drawn)
    drawn += cells

    return <Text key={slice.label} color={slice.color}>{FULL.repeat(cells)}</Text>
  })
  const markIndex = view.autoAt === null ? -1 : Math.round((view.autoAt / view.max) * width)
  const rest = Array.from({ length: width - drawn }, (_, i) =>
    drawn + i === markIndex ? MARK : EMPTY,
  )

  return (
    <Text>
      {pieces}
      <Text dimColor>{rest.join('')}</Text>
    </Text>
  )
}

const legendText = (slice: Slice) => `${slice.label} ${tokens(slice.tokens)}`

// Each item takes its square, a space, its text and a two-cell margin.
const fitting = (slices: readonly Slice[], width: number) => {
  let used = 0

  return slices.filter(slice => {
    used += legendText(slice).length + 4

    return used <= width
  })
}

const legend = ({ Box, Text }: Tags, slices: readonly Slice[], width: number) =>
  fitting([...slices].sort((a, b) => b.tokens - a.tokens).slice(0, LEGEND_SIZE), width)
    .map(slice => (
      <Box key={slice.label} flexDirection="row" marginLeft={2} flexShrink={0}>
        <Text color={slice.color}>{SQUARE} </Text>
        <Text dimColor>{legendText(slice)}</Text>
      </Box>
    ))

const contextRows = (tags: Tags, view: ContextView | null, width: number) => {
  const { Box, Text } = tags

  if (view === null || view.max === 0) {
    return null
  }

  const percent = `${Math.round((view.used / view.max) * 100)}%`
  const usage = `${tokens(view.used)}/${tokens(view.max)}`
  const auto = view.autoAt === null ? '' : `· auto ${tokens(view.autoAt)}`
  const isNearAuto = view.autoAt !== null && view.used >= view.autoAt * 0.9
  const tail = [percent, usage, auto].filter(text => text !== '')
  const tailWidth = tail.reduce((sum, text) => sum + text.length + 1, 0)
  const barWidth = Math.max(MIN_BAR, width - LABEL_WIDTH - tailWidth)

  return (
    <Box key="context" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box width={LABEL_WIDTH - 1} flexShrink={0}>
          <Text dimColor>Context</Text>
        </Box>
        {stackedBar(tags, view, barWidth)}
        <Text color={isNearAuto ? 'warning' : 'text'}>{percent}</Text>
        <Text dimColor>{usage}</Text>
        {auto !== '' && <Text dimColor>{auto}</Text>}
      </Box>
      <Box flexDirection="row" justifyContent="flex-end" width={width}>
        {legend(tags, view.slices, width)}
      </Box>
    </Box>
  )
}

const warmthText = ({ Text }: Tags, view: CacheView, at: number, ttlMs: number) => {
  if (view.sentAt === null) {
    return null
  }

  const left = view.sentAt + ttlMs - at

  return left > 0 ? (
    <Text color="success">{`warm ${warmLeft(left)}`}</Text>
  ) : (
    <Text color="warning">cold</Text>
  )
}

const cacheRow = (
  tags: ButtonTags,
  view: CacheView,
  at: number,
  ttlMs: number,
  width: number,
  sessionCost: number | null,
  onWarm: () => void,
) => {
  const { Box, Button, Text } = tags

  return (
    <Box key="cache" flexDirection="row" justifyContent="flex-end" gap={1} width={width}>
      {sessionCost !== null && <Text dimColor>Session</Text>}
      {sessionCost !== null && <Text>{usd(sessionCost)}</Text>}
      {sessionCost !== null && <Text dimColor>·</Text>}
      <Text dimColor>Cache</Text>
      <Text>{view.hitPercent === null ? '–' : `${Math.round(view.hitPercent)}% hit`}</Text>
      {view.sentAt !== null && <Text dimColor>·</Text>}
      {warmthText(tags, view, at, ttlMs)}
      {view.sentAt !== null && (
        <Button
          key="warm"
          label={view.isWarming ? 'Warming…' : 'Warm'}
          variant="secondary"
          onPress={onWarm}
        />
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const ttlMs = TTL_MS[String(options.cacheTtl ?? '1h')] ?? HOUR
  registerActivity(on)
  registerWorkspace(on)
  registerPulse(on)

  on('session.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    await adoptStoredLimits($)
    const usage = await $.session.usage()
    await saveLimits($, usage.rateLimits)
    await saveCost($, usage.cost?.usd)
    await refreshContext($)
    await startActivity($, e.cwd)
    await startWorkspace($, e.cwd)
    $.clock.every(SECOND, () => void tick($, ttlMs))

    return next(e)
  })

  // A /clear wipes plugin state and raises no session.start, only this.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await adoptStoredLimits($)
      await refreshContext($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await saveLimits($, e.rateLimits)
    }

    await saveCost($, e.cost?.usd)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (isForking) {
      return yield* next(e)
    }

    if (e.agentId === undefined) {
      isTurnRunning = true
      const at = await $.clock.now()
      await update($, cache, view => ({ ...view, sentAt: at }))

      if (e.index === 0) {
        await startPulse($, at)
      }
    }

    const result = yield* next(e)
    await addOutput($, result.usage?.output_tokens ?? 0)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    isTurnRunning = false
    const hitPercent = e.usage === undefined ? null : hitOf(e.usage)

    if (hitPercent !== null) {
      await update($, cache, view => ({ ...view, hitPercent }))
    }

    await refreshContext($)
    await endPulse($, await $.clock.now())
    void refreshWorkspace($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refreshContext($)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    const tags = $.ui.resolve(e)
    const at = await read($, now)
    const isSplit = e.props.bodyColumns >= SPLIT_MIN_COLUMNS
    const paneWidth = Math.floor(e.props.bodyColumns * PANE_SHARE)
    const width = isSplit ? paneWidth : e.props.bodyColumns
    const centerWidth = e.props.bodyColumns - 2 * paneWidth - SEPARATOR_WIDTH
    const contextView = await read($, context)
    const limitList = limitRows(tags, await read($, limits), at, width)
    const gauges = [
      cacheRow(tags, await read($, cache), at, ttlMs, width, await readCost($), () => void warm($)),
      ...limitList,
      contextRows(tags, contextView, width),
    ]
    const gaugeHeight = 1 + limitList.length + (contextView === null ? 0 : 2)
    const height = Math.max(MIN_LEFT_ROWS, gaugeHeight)
    const right = <tags.Box flexDirection="column" width={width}>{gauges}</tags.Box>
    const center = [...(await workspaceRows($, tags)), ...(await pulseRows($, tags, at))]
    const separator = (key: string) => (
      <tags.Box key={key} width={SEPARATOR_WIDTH} flexShrink={0} justifyContent="center">
        <tags.Text dimColor>{Array.from({ length: Math.max(height, center.length) }, () => SEPARATOR).join('\n')}</tags.Text>
      </tags.Box>
    )

    return (
      <tags.Box flexDirection="column">
        {isSplit ? (
          <tags.Box flexDirection="row">
            <tags.Box width={paneWidth - SEPARATOR_WIDTH} flexShrink={0}>
              {await activityPane($, tags, e.props.isWorking, height)}
            </tags.Box>
            {separator('left-separator')}
            <tags.Box flexDirection="row" justifyContent="center" alignItems="center" width={centerWidth} flexShrink={0}>
              <tags.Box flexDirection="column" flexShrink={1}>
                {center}
              </tags.Box>
            </tags.Box>
            {separator('right-separator')}
            {right}
          </tags.Box>
        ) : (
          right
        )}
        {below}
      </tags.Box>
    )
  })
}
