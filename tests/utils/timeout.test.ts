import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isAbortError,
  resolveTimeoutMs,
  withTimeout,
} from '../../src/utils/timeout.ts'

function assertAbortError(err: unknown): boolean {
  return isAbortError(err)
}

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

  it('rejects immediately on a pre-aborted signal', async () => {
    const hang = new Promise<number>(() => {})
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    await assert.rejects(() => withTimeout(hang, 5_000, 'pre-aborted', controller.signal), assertAbortError)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 200, `expected immediate abort, took ${elapsed}ms`)
  })

  it('rejects when aborted mid-wait, clears timer, and does not wait the full timeout', async () => {
    const hang = new Promise<number>(() => {})
    const controller = new AbortController()
    const timeoutMs = 2_000
    const started = Date.now()
    const pending = withTimeout(hang, timeoutMs, 'abort-mid-wait', controller.signal)
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(() => pending, assertAbortError)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 500, `expected abort well under timeout, took ${elapsed}ms`)
    await new Promise((resolve) => setTimeout(resolve, 80))
  })

  it('resolveTimeoutMs falls back on empty/invalid', () => {
    assert.equal(resolveTimeoutMs(undefined, 120_000), 120_000)
    assert.equal(resolveTimeoutMs('', 120_000), 120_000)
    assert.equal(resolveTimeoutMs('abc', 120_000), 120_000)
    assert.equal(resolveTimeoutMs('0', 120_000), 120_000)
    assert.equal(resolveTimeoutMs('1500', 120_000), 1500)
  })
})
