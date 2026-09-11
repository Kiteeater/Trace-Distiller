import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import {
  FAIL_CLOSED_KEEP_RULE,
  deadEndSummary,
  decideCut,
  failClosedKeep,
} from '../../src/domain/cut_decision.ts'
import type { LabelDecision } from '../../src/domain/label_decision.ts'
import type { Label } from '../../src/enums/label.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

function labeled(label: Label, id = 's0001'): LabelDecision {
  return {
    segment_id: id,
    label,
    source: { kind: 'rule', name: 'test_rule' },
    confidence: 1,
    rule_name: 'test_rule',
  }
}

function card(head: string): SegmentCard {
  return {
    id: 's0001',
    tool: 'Bash',
    sig: 'Bash:x',
    outcome: 'error',
    rep_of: null,
    reads: [],
    writes: [],
    tokens: 4,
    focus: 'line',
    head,
    raw_refs: ['t1'],
  }
}

describe('decideCut', () => {
  it('maps labels against the default profile including collapse_uncertain', () => {
    const rows: Array<[Label, 'keep' | 'collapse' | 'drop']> = [
      ['key_decision', 'keep'],
      ['useful_exploration', 'keep'],
      ['dead_end', 'collapse'],
      ['routine', 'drop'],
      ['collapse_uncertain', 'collapse'],
    ]
    for (const [label, action] of rows) {
      const d = decideCut(labeled(label), DEFAULT_CUT_PROFILE, card(`head-${label}`))
      assert.equal(d.action, action, label)
      assert.equal(d.from_label, label)
      assert.equal(d.profile_id, DEFAULT_CUT_PROFILE.id)
      if (action === 'collapse') {
        assert.equal(d.dead_end_summary, 'Bash error')
      } else {
        assert.equal(d.dead_end_summary, undefined)
      }
    }
  })

  it('prefers keep when a label is listed in more than one bucket', () => {
    const profile = {
      ...DEFAULT_CUT_PROFILE,
      keep_labels: ['routine'],
      collapse_labels: ['routine'],
      drop_labels: ['routine'],
    }
    assert.equal(decideCut(labeled('routine'), profile).action, 'keep')
  })

  it('truncates collapse summary by profile.dead_end.summary_max_chars', () => {
    const profile = {
      ...DEFAULT_CUT_PROFILE,
      dead_end: { ...DEFAULT_CUT_PROFILE.dead_end, summary_max_chars: 8 },
    }
    const d = decideCut(labeled('dead_end'), profile, card('abcdefghijklmnop'))
    // Compact form is "Bash error" (10 chars) → truncated to 8.
    assert.equal(d.dead_end_summary, 'Bash err')
  })
})

describe('failClosedKeep', () => {
  it('never returns drop or collapse', () => {
    const d = failClosedKeep('s0009', DEFAULT_CUT_PROFILE.id)
    assert.equal(d.action, 'keep')
    assert.equal(d.source.kind, 'rule')
    assert.equal(d.source.name, FAIL_CLOSED_KEEP_RULE)
    assert.equal(d.from_label, undefined)
    assert.equal(d.dead_end_summary, undefined)
  })
})

describe('deadEndSummary', () => {
  it('does not truncate when max chars is not a finite number', () => {
    assert.equal(deadEndSummary('full head', Number.NaN), 'full head')
    assert.equal(deadEndSummary('', 12), 'dead_end')
  })

  it('prefers compact tool+outcome over long head; still respects summary_max_chars', () => {
    const d = decideCut(
      labeled('dead_end'),
      DEFAULT_CUT_PROFILE,
      card('x'.repeat(200)),
    )
    assert.equal(d.dead_end_summary, 'Bash error')
    assert.ok(d.dead_end_summary!.length <= DEFAULT_CUT_PROFILE.dead_end.summary_max_chars)
  })

  it('falls back to head text when given a bare string', () => {
    assert.equal(deadEndSummary('x'.repeat(100), 80), 'x'.repeat(80))
  })
})
