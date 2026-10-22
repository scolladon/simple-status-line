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

import type { Line } from './line'
import { activityPane, pollAgents, registerActivity, startActivity } from './activity'
import { modelLabel, recordStep, startModel } from './model'
import { addOutput, endPulse, failureLine, pulseLine, readCost, registerPulse, saveCost, startPulse, usd } from './pulse'
import { refreshWorkspace, registerWorkspace, startWorkspace, workspaceLine } from './workspace'

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

const MIN_BAR = 8
const MIN_LIMIT_BAR = 3
const WINDOW_TAG_WIDTH = 2
const PERCENT_WIDTH = 4
const RESET_WIDTH = 6
// Tag, percent, reset and the three gaps around the bar and the percent.
const LIMIT_WINDOW_FIXED = WINDOW_TAG_WIDTH + PERCENT_WIDTH + RESET_WIDTH + 3
const LIMIT_WINDOW_GAP = 2
const LEGEND_SIZE = 5
const SPLIT_MIN_COLUMNS = 100
// Wide enough for both limit bars and the context bar to stay readable.
const GAUGE_WIDTH = 48
const RIGHT_MAX_SHARE = 0.6
const DOT_GAP = ' · '
// Reserved at their widest ('warm 59m', '[ Warming… ]') so the countdown does not shift the panes.
const WARMTH_WIDTH = 8
const WARM_BUTTON_WIDTH = 12
const AUTO_COLOR: Color = 'warning'
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

const limitWindow = (tags: Tags, window: LimitWindow, at: number, barWidth: number) => {
  const { Box, Text } = tags
  const shown = effectiveWindow(window, at)
  const left = shown.resetsAt === undefined ? null : Date.parse(shown.resetsAt) - at

  return (
    <Box key={window.kind} flexDirection="row" gap={1} flexShrink={0}>
      <Text dimColor>{WINDOW_LABEL[window.kind] ?? window.kind}</Text>
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

const limitRow = (tags: Tags, list: readonly LimitWindow[], at: number, width: number) => {
  const shown = SHOWN_WINDOWS.map(kind => list.find(window => window.kind === kind))
    .filter((window): window is LimitWindow => window !== undefined)

  if (shown.length === 0) {
    return null
  }

  const gaps = (shown.length - 1) * LIMIT_WINDOW_GAP
  const barWidth = Math.max(MIN_LIMIT_BAR, Math.floor((width - gaps) / shown.length) - LIMIT_WINDOW_FIXED)

  return (
    <tags.Box key="limits" flexDirection="row" justifyContent="space-between" width={width}>
      {shown.map(window => limitWindow(tags, window, at, barWidth))}
    </tags.Box>
  )
}

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
  const markIndex = view.autoAt === null ? -1 : Math.min(width - 1, Math.round((view.autoAt / view.max) * width))
  const isMarkShown = markIndex >= drawn
  const before = (isMarkShown ? markIndex : width) - drawn
  const after = isMarkShown ? width - markIndex - 1 : 0

  return (
    <Text>
      {pieces}
      <Text dimColor>{EMPTY.repeat(before)}</Text>
      {isMarkShown && <Text color={AUTO_COLOR}>{MARK}</Text>}
      <Text dimColor>{EMPTY.repeat(after)}</Text>
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
  const used = `${tokens(view.used)}/`
  const autoAt = view.autoAt === null ? '' : tokens(view.autoAt)
  const max = view.autoAt === null ? tokens(view.max) : `-${tokens(view.max)}`
  const isNearAuto = view.autoAt !== null && view.used >= view.autoAt * 0.9
  const tailWidth = percent.length + 1 + used.length + autoAt.length + max.length + 1
  const barWidth = Math.max(MIN_BAR, width - tailWidth)

  return (
    <Box key="context" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {stackedBar(tags, view, barWidth)}
        <Text color={isNearAuto ? 'warning' : 'text'}>{percent}</Text>
        <Text>
          <Text dimColor>{used}</Text>
          {autoAt !== '' && <Text color={AUTO_COLOR}>{autoAt}</Text>}
          <Text dimColor>{max}</Text>
        </Text>
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

const summaryWords = (model: string | null, sessionCost: number | null, view: CacheView) =>
  [
    model,
    sessionCost === null ? null : usd(sessionCost),
    view.hitPercent === null ? '–' : `${Math.round(view.hitPercent)}% hit`,
  ].filter((word): word is string => word !== null)

const warmthWidth = DOT_GAP.length + WARMTH_WIDTH + 1 + WARM_BUTTON_WIDTH

const summaryLine = (
  tags: ButtonTags,
  view: CacheView,
  at: number,
  ttlMs: number,
  model: string | null,
  sessionCost: number | null,
  onWarm: () => void,
): Line => {
  const { Box, Button, Text } = tags
  const words = summaryWords(model, sessionCost, view)
  const isWarmShown = view.sentAt !== null
  const width = words.join(DOT_GAP).length + (isWarmShown ? warmthWidth : 0)

  return {
    width,
    node: (
      <Box key="summary" flexDirection="row" justifyContent="flex-end" gap={1}>
        {words.flatMap((word, index) => [
          ...(index === 0 ? [] : [<Text key={`dot-${index}`} dimColor>·</Text>]),
          <Box key={`word-${index}`} flexShrink={index === 0 ? 1 : 0}>
            <Text wrap="truncate-end">{word}</Text>
          </Box>,
        ])}
        {isWarmShown && <Text dimColor>·</Text>}
        {isWarmShown && <Box minWidth={WARMTH_WIDTH}>{warmthText(tags, view, at, ttlMs)}</Box>}
        {isWarmShown && (
          <Box minWidth={WARM_BUTTON_WIDTH}>
            <Button
              key="warm"
              label={view.isWarming ? 'Warming…' : 'Warm'}
              variant="secondary"
              onPress={onWarm}
            />
          </Box>
        )}
      </Box>
    ),
  }
}

const rightWidthOf = (columns: number, lines: readonly Line[]) =>
  Math.min(Math.floor(columns * RIGHT_MAX_SHARE), Math.max(GAUGE_WIDTH, ...lines.map(line => line.width)))

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
    await startModel($)
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
      await recordStep($, e.effort)

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
    const columns = e.props.bodyColumns
    const isSplit = columns >= SPLIT_MIN_COLUMNS
    const summary = summaryLine(tags, await read($, cache), at, ttlMs, await modelLabel($), await readCost($), () => void warm($))
    const workspaceRow = await workspaceLine($, tags)
    const lines = workspaceRow === null ? [summary] : [summary, workspaceRow]
    const width = isSplit ? rightWidthOf(columns, lines) : columns
    const contextView = await read($, context)
    const limitLine = limitRow(tags, await read($, limits), at, width)
    const failure = await failureLine($, tags)
    const rows = [...lines.map(line => line.node), ...failure, limitLine, contextRows(tags, contextView, width)]
    const rightHeight = lines.length + failure.length + (limitLine === null ? 0 : 1) + (contextView === null ? 0 : 2)
    const height = Math.max(MIN_LEFT_ROWS, rightHeight)
    const pulse = isSplit ? await pulseLine($, tags, at) : []
    const right = <tags.Box key="right" flexDirection="column" width={width} flexShrink={0}>{rows}</tags.Box>

    return (
      <tags.Box flexDirection="column">
        {isSplit ? (
          <tags.Box flexDirection="row">
            <tags.Box key="left" flexDirection="column" width={columns - width - SEPARATOR_WIDTH} flexShrink={0}>
              {pulse}
              {await activityPane($, tags, e.props.isWorking, height - pulse.length)}
            </tags.Box>
            <tags.Box width={SEPARATOR_WIDTH} flexShrink={0} justifyContent="center">
              <tags.Text dimColor>{Array.from({ length: height }, () => SEPARATOR).join('\n')}</tags.Text>
            </tags.Box>
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
