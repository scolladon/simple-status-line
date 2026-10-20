import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On } from 'claude-code'

import type { Failure, PulseView } from '../types'
import { refreshWorkspace } from './workspace'

const LABEL_WIDTH = 9
const SECOND = 1000
const MINUTE = 60 * SECOND
const EXIT_CODE = /^Exit code (\d+)$/
const DENIED_GLYPH = '⊘'
const FAILED_GLYPH = '✗'

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>

const EMPTY: PulseView = {
  startedAt: null,
  endedAt: null,
  tools: 0,
  files: [],
  outTokens: 0,
  errors: 0,
  lastFailure: null,
}

// A hot reload keeps $.state, so a value saved by an older version may lack newer fields.
export const normalizePulse = (held: Partial<PulseView>): PulseView => ({ ...EMPTY, ...held })

const pulse = atom({ plugin: 'gauge', key: 'pulse' } as const, EMPTY)

async function readPulse($: EngineInterface) {
  return normalizePulse(await read($, pulse))
}

async function updatePulse($: EngineInterface, change: (held: PulseView) => PulseView) {
  return update($, pulse, stored => change(normalizePulse(stored)))
}
const cost = atom({ plugin: 'gauge', key: 'cost' } as const, null)

const fileOf = (e: object) => ('file_path' in e && typeof e.file_path === 'string' ? e.file_path : null)

const commandOf = (e: object) =>
  'command' in e && typeof e.command === 'string' ? (e.command.trim().split('\n')[0] ?? '') : null

const meaningfulLines = (text: string) =>
  text.split('\n').map(line => line.trim()).filter(line => line !== '')

// Bash reports a non-zero exit as "Exit code N" on its first line, the output after it.
export const failureOf = (tool: string, target: string | null, text: string, isDenied: boolean): Failure => {
  const [first = '', ...rest] = meaningfulLines(text)
  const exitCode = first.match(EXIT_CODE)?.[1]

  return {
    tool,
    target,
    isDenied,
    exitCode: exitCode === undefined ? null : Number(exitCode),
    message: (exitCode === undefined ? first : rest[0]) ?? '',
  }
}

const elapsed = (duration: number) => {
  const minutes = Math.floor(duration / MINUTE)
  const seconds = Math.floor((duration % MINUTE) / SECOND)

  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

const tokens = (count: number) => (count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`)

export const usd = (value: number) => `$${value.toFixed(2)}`

export async function saveCost($: EngineInterface, value: number | undefined) {
  if (value !== undefined) {
    await update($, cost, () => value)
  }
}

export async function startPulse($: EngineInterface, at: number) {
  await update($, pulse, () => ({ ...EMPTY, startedAt: at }))
}

export async function addOutput($: EngineInterface, count: number) {
  await updatePulse($, held => ({ ...held, outTokens: held.outTokens + count }))
}

export async function endPulse($: EngineInterface, at: number) {
  await updatePulse($, held => (held.startedAt === null ? held : { ...held, endedAt: at }))
}

export async function readCost($: EngineInterface) {
  return read($, cost)
}

async function recordCall($: EngineInterface, file: string | null, failure: Failure | null) {
  const isError = failure !== null
  await updatePulse($, held => ({
    ...held,
    lastFailure: failure ?? held.lastFailure,
    tools: held.tools + 1,
    errors: held.errors + (isError ? 1 : 0),
    files: file === null || held.files.includes(file) ? held.files : [...held.files, file],
  }))
}

export const registerPulse = (on: On) => {
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const target = fileOf(e) ?? commandOf(e)
    const failure =
      ran.deny !== undefined
        ? failureOf(e.tool, target, ran.deny, true)
        : ran.isError === true
          ? failureOf(e.tool, target, ran.text ?? '', false)
          : null
    await recordCall($, fileOf(e), failure)

    if (e.tool === 'Bash') {
      void refreshWorkspace($)
    }

    return ran
  }).catch(($, e, next) => next(e))
}

const stats = ({ Text }: Tags, view: PulseView, at: number) => {
  const startedAt = view.startedAt ?? at
  const parts = [
    elapsed((view.endedAt ?? at) - startedAt),
    `${view.tools} tools`,
    `${view.files.length} files`,
    `${tokens(view.outTokens)} out`,
  ]

  return (
    <Text wrap="truncate-end">
      <Text color={view.endedAt === null ? 'claude' : 'text'}>{parts[0]}</Text>
      <Text dimColor>{` · ${parts.slice(1).join(' · ')}`}</Text>
      {view.errors > 0 && <Text color="error">{` · ${view.errors} failed`}</Text>}
    </Text>
  )
}

const failureRow = ({ Box, Text }: Tags, failure: Failure) => {
  const parts = [
    failure.target ?? failure.tool,
    ...(failure.exitCode === null ? [] : [`exit ${failure.exitCode}`]),
    ...(failure.message === '' ? [] : [failure.message]),
  ]

  return (
    <Box key="failure" flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0} />
      <Text color={failure.isDenied ? 'warning' : 'error'} wrap="truncate-end">
        {`${failure.isDenied ? DENIED_GLYPH : FAILED_GLYPH} ${parts.join(' · ')}`}
      </Text>
    </Box>
  )
}

export async function pulseRows($: EngineInterface, tags: Tags, at: number) {
  const { Box, Text } = tags
  const view = await readPulse($)

  if (view.startedAt === null) {
    return []
  }

  const label = view.endedAt === null ? 'Turn' : 'Last turn'

  return [
    <Box key="turn" flexDirection="row">
      <Box width={LABEL_WIDTH + (label.length >= LABEL_WIDTH ? 1 : 0)} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      {stats(tags, view, at)}
    </Box>,
    ...(view.lastFailure === null ? [] : [failureRow(tags, view.lastFailure)]),
  ]
}
