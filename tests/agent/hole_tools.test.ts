import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HOLE_TOOL_NAMES } from '../../src/agent/extension.ts'
import {
  buildHoleCustomTools,
  L4_REPLAY_CODING_TOOLS,
  resolvePiToolRegistration,
} from '../../src/agent/sessions/hole_tools.ts'
import { executeHoleTool } from '../../src/agent/tools/registry.ts'
import type { RawTrace } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

describe('hole custom tools registration', () => {
  it('builds the closed-set cut-brain / hole tools', () => {
    const tools = buildHoleCustomTools(HOLE_TOOL_NAMES)
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['apply_rules_hint', 'check_continuity', 'keep_segment', 'label_segment', 'read_segment'],
    )
  })

  it('maps empty tools to noTools=all', () => {
    const reg = resolvePiToolRegistration([])
    assert.deepEqual(reg, { tools: [], noTools: 'all' })
  })

  it('maps hole tool names to customTools + noTools=builtin', () => {
    const reg = resolvePiToolRegistration(HOLE_TOOL_NAMES)
    assert.equal(reg.noTools, 'builtin')
    assert.deepEqual(reg.tools.sort(), [
      'apply_rules_hint',
      'check_continuity',
      'keep_segment',
      'label_segment',
      'read_segment',
    ])
    assert.equal(reg.customTools?.length, 5)
  })

  it('ignores unknown tool names so coding tools stay out', () => {
    const reg = resolvePiToolRegistration(['label_segment', 'bash', 'read'])
    assert.deepEqual(reg.tools, ['label_segment'])
    assert.equal(reg.customTools?.length, 1)
    assert.equal(reg.noTools, 'builtin')
  })
  it('maps pure coding allowlist without noTools (L4 replay)', () => {
    const reg = resolvePiToolRegistration(L4_REPLAY_CODING_TOOLS)
    assert.deepEqual(reg.tools, [...L4_REPLAY_CODING_TOOLS])
    assert.equal(reg.noTools, undefined)
    assert.equal(reg.customTools, undefined)
  })

  it('registry dispatches closed-set handlers and rejects unknown / missing read context', () => {
    const labeled = executeHoleTool('label_segment', {
      segment_id: 's0001',
      label: 'routine',
      confidence: 0.4,
    })
    assert.equal(labeled.ok, true)
    if (labeled.ok) {
      assert.equal(labeled.name, 'label_segment')
      assert.equal(labeled.accepted.segment_id, 's0001')
      assert.equal(labeled.accepted.label, 'routine')
    }

    const unknown = executeHoleTool('edit_trace', { segment_id: 's0001' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.match(unknown.error, /unknown hole tool/)

    const noRead = executeHoleTool('read_segment', { segment_id: 's0001' })
    assert.equal(noRead.ok, false)
    if (!noRead.ok) assert.match(noRead.error, /read context/)

    const card: SegmentCard = {
      id: 's0001',
      tool: 'Read',
      sig: 'Read:s0001',
      outcome: 'ok',
      rep_of: null,
      reads: [],
      writes: [],
      tokens: 3,
      focus: 'card',
      head: 'h',
      raw_refs: ['t1'],
    }
    const raw: RawTrace = {
      meta: { trace_id: 't', source: 'claude-code', ground_truth_ref: 'g', total_tokens: 1 },
      ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
      turns: [{ id: 't1', role: 'assistant', content: 'BODY', tokens: 1 }],
      anchor_turn_ids: [],
    }
    const read = executeHoleTool('read_segment', { segment_id: 's0001' }, { read: { cards: [card], raw } })
    assert.equal(read.ok, true)
    if (read.ok && read.name === 'read_segment') {
      assert.equal(read.accepted.text, 'BODY')
    }
  })

})
