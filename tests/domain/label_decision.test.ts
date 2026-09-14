import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertNoRuledOverwrite,
  isResolvedByRules,
  isRuledOverwriteError,
  mergeAdoptedWithBrain,
  RULED_OVERWRITE_REFUSED_MESSAGE,
  type LabelDecision,
} from '../../src/domain/label_decision.ts'
import type { Label } from '../../src/enums/label.ts'

function rule(segment_id: string, label: Label = 'routine'): LabelDecision {
  return {
    segment_id,
    label,
    source: { kind: 'rule', name: 'repeat_read' },
    confidence: 1,
    rule_name: 'repeat_read',
  }
}

function brain(segment_id: string, label: Label = 'key_decision'): LabelDecision {
  return {
    segment_id,
    label,
    source: { kind: 'llm', name: 'test_fix' },
    confidence: 0.9,
  }
}

describe('mergeAdoptedWithBrain (ADR-0010/0015)', () => {
  it('isResolvedByRules is true only for rule source', () => {
    assert.equal(isResolvedByRules(rule('sX')), true)
    assert.equal(isResolvedByRules(brain('sX')), false)
  })

  it('refuses Hole B overwrite of a rule-adopted id; keeps the rule label', () => {
    const adopted = [rule('sX', 'routine')]
    const brainDecisions = [brain('sX', 'key_decision')]
    const merged = mergeAdoptedWithBrain(adopted, brainDecisions)
    const kept = merged.decisions.find((d) => d.segment_id === 'sX')
    assert.ok(kept)
    assert.equal(kept!.source.kind, 'rule')
    assert.equal(kept!.label, 'routine')
    assert.notEqual(kept!.source.kind, 'llm')
    assert.deepEqual(merged.rejected_overwrites, ['sX'])
    assert.throws(
      () => assertNoRuledOverwrite(merged),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('RULED_OVERWRITE_REFUSED') &&
        err.message.includes('sX') &&
        isRuledOverwriteError(err),
    )
    assert.match(RULED_OVERWRITE_REFUSED_MESSAGE, /isResolvedByRules/)
  })

  it('happy path: brain only on unresolved ids → adopted ∪ brain', () => {
    const adopted = [rule('s1', 'routine'), rule('s3', 'dead_end')]
    const brainDecisions = [brain('s2', 'key_decision')]
    const merged = mergeAdoptedWithBrain(adopted, brainDecisions)
    assert.deepEqual(merged.rejected_overwrites, [])
    assert.doesNotThrow(() => assertNoRuledOverwrite(merged))
    const byId = new Map(merged.decisions.map((d) => [d.segment_id, d]))
    assert.equal(byId.get('s1')?.source.kind, 'rule')
    assert.equal(byId.get('s1')?.label, 'routine')
    assert.equal(byId.get('s3')?.label, 'dead_end')
    assert.equal(byId.get('s2')?.source.kind, 'llm')
    assert.equal(byId.get('s2')?.label, 'key_decision')
    assert.equal(merged.decisions.length, 3)
  })

  it('dedupes rejected ids when brain repeats a ruled segment', () => {
    const merged = mergeAdoptedWithBrain([rule('sX')], [brain('sX'), brain('sX', 'dead_end')])
    assert.deepEqual(merged.rejected_overwrites, ['sX'])
    assert.equal(merged.decisions.length, 1)
    assert.equal(merged.decisions[0]!.label, 'routine')
  })
})
