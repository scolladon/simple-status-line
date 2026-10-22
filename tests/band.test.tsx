import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-20T10:00:00Z')

const MESSAGES: readonly unknown[] = []

const BAND = {
  plugin: 'simple-status-line',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
} as const

const USAGE = {
  startedAt: NOW,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-20T12:30:00Z' },
    { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-10-23T10:00:00Z' },
  ],
  context: {
    tokens: 60_000,
    window: 200_000,
    percent: 30,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 10_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 50_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 140_000, color: 'inactive', isDeferred: false, kind: 'free' },
      ],
      totalTokens: 60_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 30,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167_000,
    },
  },
}

test('Given limits and a context breakdown, When the band draws, Then it shows each row', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Act
  const sut = await $.ui.mount(BAND)
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(texts).toContain('42%')
  expect(texts).toContain('2h30')
  expect(texts).toContain('3d 0h')
  expect(texts).toContain('60k/')
  expect(texts).toContain('-200k')
  expect(texts.some(text => text.includes('auto'))).toBe(false)
  expect(texts).toContain('messages 50k')
  expect(texts).toContain('–')
  expect(await sut.find({ type: 'Button', key: 'warm' })).toBeUndefined()
  await sut.unmount()
})

test('Given a running subagent and a command, When the band draws wide, Then the left pane lists them', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'Explore', description: 'scan', status: 'running' }],
  }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: e.argv.includes('rev-parse')
        ? '/home/me/repo-wt\n/home/me/repo/.git/worktrees/repo-wt\n/home/me/repo/.git\n'
        : '# branch.head feat/split\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b src/app.ts\n',
    },
  }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/home/me/repo-wt', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test\necho done' })
  await $.tool.call({ tool: 'Read', file_path: '/home/me/repo-wt/src/app.ts' })

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true, bodyColumns: 160 } })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(texts).toContain('▸ no todos')
  expect(texts).toContain('main')
  expect(texts).toContain('Explore')
  expect(texts).toContain('› src/app.ts')
  expect(texts).toContain('42%')
  expect(texts).toContain('~/repo-wt')
  expect(texts).toContain('⎇ ')
  expect(texts).toContain('repo')
  expect(texts).toContain('feat/split')
  expect(texts).toContain(' ↑2')
  expect(texts).toContain(' ⊂ repo-wt')
  expect(texts.some(text => ['Path', 'Git', 'Worktree'].includes(text))).toBe(false)
  await sut.unmount()
})

test('Given background shell, monitor and subagent at stop, When the band draws wide, Then one row each lists shell and monitor below the task', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev\n--watch' },
      { id: 'm1', type: 'monitor', status: 'running', description: 'watch ci' },
      { id: 's1', type: 'subagent', status: 'running', description: 'scan', agent_type: 'Explore' },
    ],
  })

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  const taskAt = texts.indexOf('▸ no todos')
  expect(texts.indexOf('⧗ $ npm run dev')).toBe(taskAt + 1)
  expect(texts.indexOf('⧗ ◉ watch ci')).toBe(taskAt + 2)
  expect(texts.some(text => text.includes('scan'))).toBe(false)
  await sut.unmount()
})

test('Given no background work at stop, When the band draws wide, Then no background row shows', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(texts.some(text => text.startsWith('⧗'))).toBe(false)
  await sut.unmount()
})

test('Given a main-loop step with effort, When the band draws wide, Then the left pane starts with the pulse and the right pane with model and effort', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const _ of step) {
    // Drained so the step settles.
  }

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  const modelAt = texts.indexOf('Opus 5.5 · high')
  expect(modelAt).toBeGreaterThanOrEqual(0)
  expect(modelAt).toBeLessThan(texts.indexOf('/'))
  expect(texts.indexOf('▶ ')).toBeLessThan(texts.indexOf('▸ no todos'))
  expect(texts.some(text => ['Model', 'Path', 'Turn', 'Last turn'].includes(text))).toBe(false)
  await sut.unmount()
})

test('Given both limit windows, When the band draws wide, Then they share one untitled row', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const row = await sut.find({ type: 'Box', key: 'limits' })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(row).toBeDefined()
  expect(texts).toContain('5h')
  expect(texts).toContain('7d')
  expect(texts.some(text => /^(Limits?|Context|Session|Cache)\b/.test(text))).toBe(false)
  await sut.unmount()
})

test('Given a repository opened at its root, When the band draws wide, Then the git line leaves out the repo name the path already ends with', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: e.argv.includes('rev-parse')
        ? '/home/me/repo\n/home/me/repo/.git\n/home/me/repo/.git\n'
        : '# branch.head main\n# branch.ab +0 -0\n',
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(texts).toContain('~/repo')
  expect(texts).toContain('main')
  expect(texts).not.toContain('repo')
  await sut.unmount()
})

const quietSession = async (
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  MESSAGES: readonly unknown[] = [],
) => {
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('Given an auto-compact threshold, When the band draws, Then the usage names it between used and max in the mark colour', async ($, on) => {
  // Arrange
  await quietSession($, on)

  // Act
  const sut = await $.ui.mount(BAND)
  const usage = await sut.find({ type: 'Text', text: /^60k\/167k-200k$/ })
  const autoAt = await sut.find({ type: 'Text', text: /^167k$/ })
  const mark = await sut.find({ type: 'Text', text: /^│$/ })

  // Assert
  expect(usage).toBeDefined()
  expect(autoAt?.props.color).toBe('warning')
  expect(mark?.props.color).toBe(autoAt?.props.color)
  await sut.unmount()
})

test('Given short info lines, When the band draws wide, Then one separator splits a gauge-wide right pane from a left pane taking the rest', async ($, on) => {
  // Arrange
  await quietSession($, on)

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const right = await sut.find({ type: 'Box', key: 'right' })
  const left = await sut.find({ type: 'Box', key: 'left' })
  const separators = await sut.findAll({ type: 'Text', text: /^│(\n│)+$/ })

  // Assert
  expect(right?.props.width).toBe(48)
  expect(left?.props.width).toBe(160 - 48 - 3)
  expect(separators).toHaveLength(1)
  await sut.unmount()
})

test('Given a long path and git line, When the band draws wide, Then the right pane widens to fit it on one line', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: USAGE }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: e.argv.includes('rev-parse')
        ? '/home/me/projects/some-repo-wt\n/home/me/projects/some-repo/.git/worktrees/some-repo-wt\n/home/me/projects/some-repo/.git\n'
        : '# branch.head feat/a-long-branch-name\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/app.ts\n',
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/home/me/projects/some-repo-wt', surface: 'terminal', isInteractive: true })
  const line = '~/projects/some-repo-wt · ⎇ some-repo · feat/a-long-branch-name ⊂ some-repo-wt ↑2 ↓1 · 1 changed'

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 200 } })
  const right = await sut.find({ type: 'Box', key: 'right' })
  const left = await sut.find({ type: 'Box', key: 'left' })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(right?.props.width).toBe(line.length)
  expect(left?.props.width).toBe(200 - line.length - 3)
  expect(texts.indexOf('~/projects/some-repo-wt')).toBeLessThan(texts.indexOf('feat/a-long-branch-name'))
  await sut.unmount()
})

test('Given a resumed transcript holding task calls, When the band draws wide before any new call, Then the task row shows them', async ($, on) => {
  // Arrange
  const answered = (id: string, tool: string, input: Record<string, unknown>, result?: unknown) =>
    ({ tool_use_id: id, tool, input, result, text: 'ok' })
  const transcript = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        answered('u1', 'TaskCreate', { subject: 'Write tests', description: '', activeForm: 'Writing tests' }, { task: { id: '1' } }),
        answered('u2', 'TaskCreate', { subject: 'Ship', description: '' }, { task: { id: '2' } }),
        { ...answered('u3', 'TaskCreate', { subject: 'Refused', description: '' }), isError: true },
        answered('u4', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      ],
    },
  ]
  await quietSession($, on, transcript)

  // Act
  const sut = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  const texts = (await sut.findAll({ type: 'Text' })).map(found => found.text)

  // Assert
  expect(texts).toContain('▸ Writing tests')
  expect(texts).toContain('0/2')
  await sut.unmount()
})
