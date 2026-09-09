import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SPAN_MAX_GAP_SEGMENTS } from '../../src/constant/window.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { isSpanFailure } from '../../src/domain/span_violation.ts'
import {
  assemble,
  WarrantCoverageError,
  type AssembleInput,
} from '../../src/pipeline/assembler.ts'
import type { AgentView } from '../../src/types/agent_view.ts'
import type { CutWarrant, CutWarrantEntry } from '../../src/types/cut_warrant.ts'
import type { RawTrace, RawTurn, RawTurnRole } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'
import type { CutAction } from '../../src/enums/cut_action.ts'

function makeTurn(id: string, role: RawTurnRole, content: string): RawTurn {
  return { id, role, content, tokens: estimateTokens(content) }
}

function card(id: string, raw_refs: string[]): SegmentCard {
  return {
    id,
    tool: 'Read',
    sig: `Read:${id}`,
    outcome: 'ok',
    rep_of: null,
    reads: ['f.ts'],
    writes: [],
    tokens: 8,
    focus: 'card',
    head: `head-${id}`,
    raw_refs,
  }
}

function rawOf(turns: RawTurn[]): RawTrace {
  return {
    meta: {
      trace_id: 'synth:assembler',
      source: 'claude-code',
      ground_truth_ref: 'turn:t-gt',
      total_tokens: turns.reduce((sum, t) => sum + t.tokens, 0),
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'turn:t-gt' },
    turns,
    anchor_turn_ids: turns[0] === undefined ? [] : [turns[0].id],
  }
}

function viewOf(segments: SegmentCard[]): AgentView {
  return {
    meta: {
      trace_id: 'synth:assembler',
      source: 'claude-code',
      ground_truth_ref: 'turn:t-gt',
      total_tokens: segments.reduce((sum, s) => sum + s.tokens, 0),
    },
    intent_hypothesis: { version: 0, text: '', scenario: undefined },
    skeleton: { version: 0, nodes: [] },
    segments,
  }
}

function entry(segment_id: string, action: CutAction, summary?: string): CutWarrantEntry {
  const e: CutWarrantEntry = {
    segment_id,
    action,
    source: { kind: 'rule', name: 'test' },
    confidence: 1,
  }
  if (summary !== undefined) e.dead_end_summary = summary
  return e
}

function warrantOf(entries: CutWarrantEntry[]): CutWarrant {
  return { trace_id: 'synth:assembler', entries }
}

function nSegments(n: number): { raw: RawTrace; view: AgentView; ids: string[] } {
  const turns: RawTurn[] = []
  const segments: SegmentCard[] = []
  const ids: string[] = []
  for (let i = 1; i <= n; i += 1) {
    const tid = `t${String(i)}`
    const sid = `s${String(i).padStart(4, '0')}`
    turns.push(makeTurn(tid, 'tool_call', `body-${sid}-verbatim`))
    segments.push(card(sid, [tid]))
    ids.push(sid)
  }
  return { raw: rawOf(turns), view: viewOf(segments), ids }
}

function run(
  n: number,
  actions: CutAction[],
  extra?: Partial<AssembleInput> & { summaries?: Record<string, string> },
) {
  const { raw, view, ids } = nSegments(n)
  assert.equal(actions.length, n)
  const entries = ids.map((id, i) => {
    const action = actions[i]
    assert.ok(action)
    return entry(id, action, extra?.summaries?.[id])
  })
  return assemble({
    raw,
    view,
    warrant: warrantOf(entries),
    profile: extra?.profile ?? DEFAULT_CUT_PROFILE,
    ...(extra?.continuity !== undefined ? { continuity: extra.continuity } : {}),
  })
}

describe('assembler', () => {
  it('rejects a warrant that does not cover every segment id', () => {
    const { raw, view, ids } = nSegments(3)
    const entries = [entry(ids[0]!, 'keep'), entry(ids[1]!, 'keep')]
    assert.throws(
      () => assemble({ raw, view, warrant: warrantOf(entries), profile: DEFAULT_CUT_PROFILE }),
      (err: unknown) => err instanceof WarrantCoverageError && String(err.message).includes(ids[2]!),
    )
  })

  it('puts drop ids in plan.dropped and never in either projection body', () => {
    const out = run(4, ['keep', 'drop', 'drop', 'keep'])
    assert.deepEqual(out.plan.dropped, ['s0002', 's0003'])
    assert.deepEqual(out.plan.kept, ['s0001', 's0004'])
    assert.equal(out.plan.collapsed.length, 0)
    assert.equal(out.plan.span_ok, true)

    const trainingIds = out.training.turns.map((t) => t.id)
    assert.deepEqual(trainingIds, ['t1', 't4'])
    assert.equal(trainingIds.includes('t2'), false)
    assert.equal(trainingIds.includes('t3'), false)
    assert.deepEqual(
      out.playback.cards.map((c) => c.id),
      ['s0001', 's0004'],
    )
  })

  it('projects training and playback from the same plan; keep turns are byte-identical', () => {
    const { raw, view, ids } = nSegments(3)
    const out = assemble({
      raw,
      view,
      warrant: warrantOf([
        entry(ids[0]!, 'keep'),
        entry(ids[1]!, 'collapse', 'tried X, excluded'),
        entry(ids[2]!, 'keep'),
      ]),
      profile: DEFAULT_CUT_PROFILE,
    })

    assert.equal(out.training.plan_ref, out.playback.plan_ref)
    assert.equal(out.training.trace_id, out.playback.trace_id)
    assert.equal(out.training.trace_id, out.plan.trace_id)
    assert.deepEqual(out.plan.kept, ['s0001', 's0003'])
    assert.deepEqual(
      out.playback.cards.map((c) => c.id),
      out.plan.kept,
    )
    assert.deepEqual(
      out.playback.collapsed.map((c) => c.segment_id),
      ['s0002'],
    )
    assert.equal(out.playback.collapsed[0]?.summary, 'tried X, excluded')

    const originalKeep = raw.turns.filter((t) => t.id === 't1' || t.id === 't3')
    const projectedKeep = out.training.turns.filter((t) => t.id === 't1' || t.id === 't3')
    assert.deepEqual(projectedKeep, originalKeep)
    assert.equal(out.training.turns[0], raw.turns[0])
    assert.equal(out.training.turns[1]?.content, 'tried X, excluded')
    assert.equal(out.training.turns[1]?.id, 'collapse:s0002')
    assert.equal(out.training.turns[2], raw.turns[2])

    const keepHead = out.playback.cards[0]
    const srcHead = view.segments[0]
    assert.ok(keepHead)
    assert.ok(srcHead)
    assert.equal(keepHead.head, srcHead.head)
    assert.equal(keepHead.sig, srcHead.sig)
    assert.deepEqual(keepHead.raw_refs, srcHead.raw_refs)
  })

  it('preserves original segment order and does not shuffle warrant entry order', () => {
    const { raw, view, ids } = nSegments(3)
    const out = assemble({
      raw,
      view,
      warrant: warrantOf([
        entry(ids[2]!, 'keep'),
        entry(ids[0]!, 'keep'),
        entry(ids[1]!, 'drop'),
      ]),
      profile: DEFAULT_CUT_PROFILE,
    })
    assert.deepEqual(out.plan.kept, ['s0001', 's0003'])
    assert.deepEqual(out.plan.dropped, ['s0002'])
    assert.deepEqual(
      out.playback.cards.map((c) => c.id),
      ['s0001', 's0003'],
    )
  })

  it('throws SpanFailure when adjacent keep gap exceeds SPAN_MAX_GAP_SEGMENTS; plan is not span_ok', () => {
    const n = SPAN_MAX_GAP_SEGMENTS + 3
    const actions: CutAction[] = ['keep', ...Array<CutAction>(n - 2).fill('drop'), 'keep']
    const { raw, view, ids } = nSegments(n)
    const warrant = warrantOf(ids.map((id, i) => entry(id, actions[i]!)))

    let caught: unknown
    try {
      assemble({ raw, view, warrant, profile: DEFAULT_CUT_PROFILE })
    } catch (err) {
      caught = err
    }
    assert.equal(isSpanFailure(caught), true)
    if (!isSpanFailure(caught)) return
    assert.equal(caught.plan.span_ok, false)
    assert.ok(caught.plan.span_violations.length > 0)
    assert.equal(caught.violations.length, 1)
    const v = caught.violations[0]
    assert.ok(v)
    assert.equal(v.reason, 'gap_too_large')
    assert.equal(v.left_segment_id, ids[0])
    assert.equal(v.right_segment_id, ids[n - 1])
    assert.equal(v.gap_segments, n - 2)
    assert.ok(v.gap_segments > SPAN_MAX_GAP_SEGMENTS)
    assert.deepEqual(caught.plan.dropped, ids.slice(1, n - 1))
    assert.deepEqual(caught.plan.span_violations, [v.id])
  })

  it('counts a collapse placeholder as one span step so a filled gap can pass', () => {
    const n = SPAN_MAX_GAP_SEGMENTS + 3
    const actions: CutAction[] = Array<CutAction>(n).fill('drop')
    actions[0] = 'keep'
    actions[n - 1] = 'keep'
    const mid = Math.floor(n / 2)
    actions[mid] = 'collapse'
    const sid = `s${String(mid + 1).padStart(4, '0')}`
    const out = run(n, actions, { summaries: { [sid]: 'dead end at mid' } })
    assert.equal(out.plan.span_ok, true)
    assert.equal(out.plan.collapsed.length, 1)
    assert.equal(out.plan.collapsed[0]?.segment_id, sid)
  })

  it('does not call holes when continuity is omitted; optional continuity_fail is recorded', () => {
    const ok = run(2, ['keep', 'keep'])
    assert.equal(ok.plan.span_ok, true)
    assert.deepEqual(ok.plan.span_violations, [])

    const { raw, view, ids } = nSegments(2)
    let caught: unknown
    try {
      assemble({
        raw,
        view,
        warrant: warrantOf([entry(ids[0]!, 'keep'), entry(ids[1]!, 'keep')]),
        profile: DEFAULT_CUT_PROFILE,
        continuity: [{ left: ids[0]!, right: ids[1]!, score: 0.1, ok: false }],
      })
    } catch (err) {
      caught = err
    }
    assert.equal(isSpanFailure(caught), true)
    if (!isSpanFailure(caught)) return
    assert.equal(caught.plan.span_ok, false)
    assert.equal(caught.violations[0]?.reason, 'continuity_fail')
    assert.equal(caught.violations[0]?.continuity_score, 0.1)
  })
})
