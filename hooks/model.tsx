import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface } from 'claude-code'

import type { ModelView } from '../types'

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>

const model = atom({ plugin: 'simple-status-line', key: 'model' } as const, null)

// $.session.model() names the model as /model shows it; the step's id is the API's, less readable.
async function refreshModel($: EngineInterface, effort: string | null) {
  const name = await $.session.model()
  await update($, model, () => ({ name, effort }))
}

export async function startModel($: EngineInterface) {
  const held = await read($, model)
  await refreshModel($, held?.effort ?? null)
}

// Effort is only exposed on a step, so it shows from the first request on.
export async function recordStep($: EngineInterface, effort: string | number | undefined) {
  await refreshModel($, effort === undefined ? null : String(effort))
}

export async function modelRows($: EngineInterface, { Box, Text }: Tags) {
  const view = await read($, model)

  if (view === null) {
    return []
  }

  return [
    <Box key="model" flexDirection="row">
      <Text wrap="truncate-end">{view.effort === null ? view.name : `${view.name} · ${view.effort}`}</Text>
    </Box>,
  ]
}
