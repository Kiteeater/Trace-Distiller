import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { choosePoolBudget, lexTraceId, subsampleTraceIds } from '../../src/eval/utility_budget.ts'

describe('choosePoolBudget', () => {
  it('T = min of arm pools', () => {
    assert.equal(choosePoolBudget({ raw: 100, distilled: 30, tools_only: 50 }), 30)
    assert.equal(choosePoolBudget({ raw: 10, distilled: 10, tools_only: 10 }), 10)
  })

  it('throws when no finite pools', () => {
    assert.throws(
      () => choosePoolBudget({}),
      (err: unknown) => err instanceof Error && err.message.includes('no arm pool tokens'),
    )
  })
})

describe('subsampleTraceIds', () => {
  it('greedy lex skip-and-continue fills later short traces', () => {
    const traces = {
      a: { tokens: 10 },
      b: { tokens: 50 },
      c: { tokens: 10 },
    }
    const out = subsampleTraceIds(traces, 20)
    assert.deepEqual(out.selected, ['a', 'c'])
    assert.equal(out.pool_tokens, 20)
  })

  it('arm already ≤ T keeps all', () => {
    const traces = {
      a: { tokens: 4 },
      b: { tokens: 5 },
      c: { tokens: 6 },
    }
    const out = subsampleTraceIds(traces, 20)
    assert.deepEqual(out.selected, ['a', 'b', 'c'])
    assert.equal(out.pool_tokens, 15)
  })

  it('is deterministic lexicographic (not insertion order)', () => {
    const traces = {
      z: { tokens: 1 },
      a: { tokens: 1 },
      m: { tokens: 1 },
    }
    const out = subsampleTraceIds(traces, 3)
    assert.deepEqual(out.selected, ['a', 'm', 'z'])
    assert.equal(out.pool_tokens, 3)
    const keys = Object.keys(traces)
    assert.deepEqual([...keys].sort(lexTraceId), ['a', 'm', 'z'])
  })

  it('skips a first trace larger than T and continues', () => {
    const traces = {
      a: { tokens: 100 },
      b: { tokens: 5 },
    }
    const out = subsampleTraceIds(traces, 10)
    assert.deepEqual(out.selected, ['b'])
    assert.equal(out.pool_tokens, 5)
  })

  it('never exceeds T', () => {
    const traces = {
      a: { tokens: 8 },
      b: { tokens: 8 },
      c: { tokens: 8 },
    }
    const out = subsampleTraceIds(traces, 16)
    assert.deepEqual(out.selected, ['a', 'b'])
    assert.equal(out.pool_tokens, 16)
    assert.ok(out.pool_tokens <= 16)
  })
})
