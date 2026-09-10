import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveTimeoutMs, withTimeout } from '../../src/utils/timeout.ts'

describe('withTimeout', () => {
  it('resolves when the promise finishes first', async () => {
    const value = await withTimeout(Promise.resolve(42), 1000, 'fast')
    assert.equal(value, 42)
  })

  it('rejects hanging promises without waiting forever', async () => {
    const hang = new Promise<number>(() => {})
    const started = Date.now()
    await assert.rejects(
      () => withTimeout(hang, 40, 'hang-test'),
      /hang-test timed out after 40ms/,
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 500, `expected quick timeout, took ${elapsed}ms`)
  })

  it('resolveTimeoutMs falls back on empty/invalid', () => {
    assert.equal(resolveTimeoutMs(undefined, 120_000), 120_000)
    assert.equal(resolveTimeoutMs('', 120_000), 120_000)
    assert.equal(resolveTimeoutMs('abc', 120_000), 120_000)
    assert.equal(resolveTimeoutMs('0', 120_000), 120_000)
    assert.equal(resolveTimeoutMs('1500', 120_000), 1500)
  })
})
