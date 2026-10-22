import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, On } from 'claude-code'

import type { WorkspaceView } from '../types'
import type { Line } from './line'

const GIT_TIMEOUT_MS = 5000
const BRANCH_GLYPH = '⎇ '
const WORKTREE_GLYPH = '⊂'

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type GitStatus = Pick<WorkspaceView, 'branch' | 'ahead' | 'behind' | 'changed'>

const workspace = atom({ plugin: 'simple-status-line', key: 'workspace' } as const, null)

let cwd = ''
let home = ''
let isRefreshing = false

const basename = (path: string) => path.split('/').filter(part => part !== '').pop() ?? path

const tilde = (path: string) =>
  home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

const git = async ($: EngineInterface, args: readonly string[]) => {
  const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })

  return ran.exitCode === 0 ? ran.stdout : null
}

const parseStatus = (porcelain: string): GitStatus => {
  const lines = porcelain.split('\n').filter(line => line !== '')
  const head = lines.find(line => line.startsWith('# branch.head '))?.slice('# branch.head '.length)
  const counts = lines.find(line => line.startsWith('# branch.ab '))?.match(/\+(\d+) -(\d+)/)

  return {
    branch: head === undefined || head === '(detached)' ? null : head,
    ahead: Number(counts?.[1] ?? 0),
    behind: Number(counts?.[2] ?? 0),
    changed: lines.filter(line => !line.startsWith('#')).length,
  }
}

async function readWorkspace($: EngineInterface): Promise<WorkspaceView> {
  const notRepo: WorkspaceView = { path: tilde(cwd), repo: null, branch: null, ahead: 0, behind: 0, changed: 0, worktree: null }
  const roots = await git($, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  const [top, gitDir, commonDir] = roots?.trim().split('\n') ?? []

  if (top === undefined || gitDir === undefined || commonDir === undefined) {
    return notRepo
  }

  const status = parseStatus((await git($, ['status', '--porcelain=v2', '--branch'])) ?? '')
  // A linked worktree keeps its own git dir under the main repository's common dir.
  const isLinkedWorktree = gitDir !== commonDir

  return {
    ...notRepo,
    ...status,
    repo: basename(isLinkedWorktree ? commonDir.replace(/\/\.git$/, '') : top),
    worktree: isLinkedWorktree ? basename(top) : null,
  }
}

export async function refreshWorkspace($: EngineInterface) {
  if (isRefreshing || cwd === '') {
    return
  }

  isRefreshing = true

  try {
    const view = await readWorkspace($)
    await update($, workspace, () => view)
  } catch (error) {
    // The previous view stays on screen; git missing or hung is not worth a toast.
    $.ui.log(`simple-status-line: git refresh failed in ${cwd}: ${String(error)}`, { to: 'debug' })
  } finally {
    isRefreshing = false
  }
}

export async function startWorkspace($: EngineInterface, workingDirectory: string) {
  cwd = workingDirectory
  home = (await $.env.get('HOME')) ?? ''
  await refreshWorkspace($)
}

export const registerWorkspace = (on: On) => {
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    cwd = e.new_cwd
    await refreshWorkspace($)

    return result
  }).catch(($, e, next) => next(e))
}

const PATH_GAP = ' · '

type Segment = { text: string; color?: Color; isBold?: boolean; isDim?: boolean }

const gitSegments = (view: WorkspaceView): Segment[] => {
  if (view.repo === null) {
    return [{ text: 'not a repository', isDim: true }]
  }

  const sync = [view.ahead > 0 ? `↑${view.ahead}` : '', view.behind > 0 ? `↓${view.behind}` : ''].filter(part => part !== '')
  // The path already ends with the repo name when opened at its root; repeating it is noise.
  const repo: Segment[] = basename(view.path) === view.repo ? [] : [{ text: view.repo, isBold: true }, { text: ' · ', isDim: true }]

  return [
    { text: BRANCH_GLYPH, isDim: true },
    ...repo,
    { text: view.branch ?? 'detached', color: 'suggestion' },
    ...(view.worktree === null ? [] : [{ text: ` ${WORKTREE_GLYPH} ${view.worktree}`, color: 'warning' }]),
    ...(sync.length === 0 ? [] : [{ text: ` ${sync.join(' ')}`, color: 'warning' }]),
    { text: view.changed > 0 ? ` · ${view.changed} changed` : ' · clean', isDim: true },
  ]
}

const segmentText = ({ Text }: Tags, segment: Segment, index: number) => (
  <Text key={String(index)} color={segment.color} bold={segment.isBold} dimColor={segment.isDim}>{segment.text}</Text>
)

// The width lets the right pane size itself to this line rather than to a share of the band.
export async function workspaceLine($: EngineInterface, tags: Tags): Promise<Line | null> {
  const view = await read($, workspace)

  if (view === null) {
    return null
  }

  const segments = gitSegments(view)
  const width = [view.path, PATH_GAP, ...segments.map(segment => segment.text)].join('').length

  return {
    width,
    node: (
      <tags.Box key="workspace" flexDirection="row">
        <tags.Box flexShrink={1}>
          <tags.Text wrap="truncate-start">{view.path}</tags.Text>
        </tags.Box>
        <tags.Box flexShrink={0}>
          <tags.Text dimColor>{PATH_GAP}</tags.Text>
        </tags.Box>
        <tags.Box flexShrink={2}>
          <tags.Text wrap="truncate-end">{segments.map((segment, index) => segmentText(tags, segment, index))}</tags.Text>
        </tags.Box>
      </tags.Box>
    ),
  }
}
