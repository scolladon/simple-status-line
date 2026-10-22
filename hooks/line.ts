import type { RenderElement } from 'claude-code'

// A drawn row and how many cells it needs, so a pane can size itself to its content.
export type Line = { width: number; node: RenderElement }
