import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HOLE_FETCH_TOOL_NAMES,
  HOLE_JUDGMENT_TOOL_NAMES,
  HOLE_TOOL_NAMES,
  HOLE_TOOL_STATUS,
  handleApplyRulesHint,
  handleCheckContinuity,
  handleKeepSegment,
  handleLabelSegment,
  handleReadSegment,
} from '../../src/agent/extension.ts'
import type { RawTrace } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/agent/extension.ts')

function card(id: string, refs: string[], head = 'h'): SegmentCard {
  return {
    id,
    tool: 'Read',
    sig: `Read:${id}`,
    outcome: 'ok',
    rep_of: null,
    reads: [],
    writes: [],
    tokens: 3,
    focus: 'card',
    head,
    raw_refs: refs,
  }
}

function raw(turns: RawTrace['turns']): RawTrace {
  return {
    meta: {
      trace_id: 't',
      source: 'claude-code',
      ground_truth_ref: 'g',
      total_tokens: 4,
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
    turns,
    anchor_turn_ids: [],
  }
}

describe('extension hole tool names', () => {
  it('exports LOCKED closed set without pi', () => {
    assert.equal(HOLE_TOOL_STATUS, 'LOCKED')
    assert.deepEqual([...HOLE_JUDGMENT_TOOL_NAMES], [
      'label_segment',
      'check_continuity',
      'keep_segment',
    ])
    assert.deepEqual([...HOLE_FETCH_TOOL_NAMES], ['read_segment', 'apply_rules_hint'])
    assert.deepEqual([...HOLE_TOOL_NAMES], [
      'label_segment',
      'check_continuity',
      'keep_segment',
      'read_segment',
      'apply_rules_hint',
    ])

    const src = readFileSync(srcPath, 'utf8')
    assert.match(src, /已拍板/)
    assert.doesNotMatch(src, /createAgentSession/)
    assert.doesNotMatch(src, /@mariozechner\/pi/)
    assert.doesNotMatch(src, /edit_trace|drop_segment/)
    assert.match(src, /keep_segment/)
    assert.match(src, /apply_rules_hint/)
  })
})

describe('hole tool handlers', () => {
  it('accepts a valid label_segment and drops rationale from the accepted value', () => {
    const got = handleLabelSegment({
      segment_id: 's0001',
      label: 'key_decision',
      confidence: 0.9,
      rationale: 'must not enter warrant',
    })
    assert.deepEqual(got, {
      ok: true,
      segment_id: 's0001',
      label: 'key_decision',
      confidence: 0.9,
      keep_bits: [],
    })
    assert.equal('rationale' in got, false)
  })

  it('rejects illegal labels and unknown window ids', () => {
    const bad = handleLabelSegment({ segment_id: 's0001', label: 'important', confidence: 1 })
    assert.equal(bad.ok, false)
    const out = handleLabelSegment(
      { segment_id: 's0009', label: 'routine', confidence: 1 },
      new Set(['s0001']),
    )
    assert.equal(out.ok, false)
    if (out.ok === false) assert.match(out.error, /unknown segment_id/)
  })

  it('requires continuity score 1–5', () => {
    const ok = handleCheckContinuity({
      left_id: 's0001',
      right_id: 's0002',
      reachable: true,
      score: 4,
      reason: 'same file',
    })
    assert.equal(ok.ok, true)
    const bad = handleCheckContinuity({
      left_id: 's0001',
      right_id: 's0002',
      reachable: true,
      score: 6,
      reason: 'same file',
    })
    assert.equal(bad.ok, false)
  })

  it('read_segment returns only this segment text', () => {
    const ctx = {
      cards: [
        card('s0001', ['t1', 't2']),
        card('s0002', ['t3'], 'other'),
      ],
      raw: raw([
        { id: 't1', role: 'thought', content: 'think A', tokens: 1 },
        { id: 't2', role: 'tool_result', content: 'result A', tokens: 1 },
        { id: 't3', role: 'thought', content: 'secret B', tokens: 1 },
      ]),
    }
    const got = handleReadSegment(ctx, { segment_id: 's0001' })
    assert.deepEqual(got, {
      ok: true,
      segment_id: 's0001',
      focus: 'full',
      text: 'think A\nresult A',
    })
    if (got.ok) assert.equal(got.text.includes('secret B'), false)

    const miss = handleReadSegment(ctx, { segment_id: 's9999' })
    assert.equal(miss.ok, false)
    if (miss.ok === false) {
      assert.match(miss.error, /unknown segment_id/)
      assert.equal(miss.error.includes('secret B'), false)
    }
  })

  it('keep_segment accepts window ids; apply_rules_hint accepts empty args', () => {
    const ok = handleKeepSegment({ segment_id: 's0001' }, new Set(['s0001']))
    assert.deepEqual(ok, { ok: true, segment_id: 's0001', confidence: 1, keep_bits: [] })
    const miss = handleKeepSegment({ segment_id: 's0009' }, new Set(['s0001']))
    assert.equal(miss.ok, false)
    const hint = handleApplyRulesHint({})
    assert.equal(hint.ok, true)
    const empty = handleApplyRulesHint(undefined)
    assert.equal(empty.ok, true)
  })
})
