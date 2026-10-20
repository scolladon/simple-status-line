import { expect, test } from 'claude-code/testing'

import { failureOf, normalizePulse } from '../hooks/pulse'

test('Given a Bash error with an exit code, When parsed, Then it keeps the code and the first output line', async () => {
  // Arrange
  const text = 'Exit code 1\n\n FAIL src/auth.test.ts\n  expected 2'

  // Act
  const sut = failureOf('Bash', 'npm test', text, false)

  // Assert
  expect(sut).toEqual({ tool: 'Bash', target: 'npm test', isDenied: false, exitCode: 1, message: 'FAIL src/auth.test.ts' })
})

test('Given a denial, When parsed, Then it keeps the reason and no exit code', async () => {
  // Arrange
  const reason = 'guard: .env is protected here.'

  // Act
  const sut = failureOf('Edit', '.env', reason, true)

  // Assert
  expect(sut).toEqual({ tool: 'Edit', target: '.env', isDenied: true, exitCode: null, message: reason })
})

test('Given pulse state saved before lastFailure existed, When normalized, Then lastFailure is null', async () => {
  // Arrange
  const legacy = { startedAt: 1, endedAt: 2, tools: 3, files: [], outTokens: 10, errors: 0, ticks: [] }

  // Act
  const sut = normalizePulse(legacy)

  // Assert
  expect(sut.lastFailure).toBeNull()
  expect(sut.tools).toBe(3)
})
