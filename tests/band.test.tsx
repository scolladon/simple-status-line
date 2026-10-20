import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-20T10:00:00Z')

const BAND = {
  plugin: 'gauge',
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
  expect(texts).toContain('60k/200k')
  expect(texts).toContain('· auto 167k')
  expect(texts).toContain('messages 50k')
  expect(texts).toContain('–')
  expect(await sut.find({ type: 'Button', key: 'warm' })).toBeUndefined()
  await sut.unmount()
})

test('Given a running subagent and a command, When the band draws wide, Then the left pane lists them', async ($, on) => {
  // Arrange
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
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
  expect(texts).toContain('▸ no task')
  expect(texts).toContain('main')
  expect(texts).toContain('Explore')
  expect(texts).toContain('› src/app.ts')
  expect(texts).toContain('42%')
  expect(texts).toContain('~/repo-wt')
  expect(texts).toContain('repo')
  expect(texts).toContain('feat/split')
  expect(texts).toContain(' ↑2')
  expect(texts).toContain('repo-wt')
  await sut.unmount()
})
