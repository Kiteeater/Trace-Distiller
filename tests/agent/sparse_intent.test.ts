import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildCandidatePool,
  sampleCandidates,
  type CandidateEntry,
} from '../../src/agent/sessions/candidate_pool.ts'
import {
  FakeSessionBackend,
  type SessionPromptInput,
  type SessionPromptResult,
} from '../../src/agent/sessions/open_session.ts'
import {
  assertNoCutActions,
  parseSparseIntentJson,
  sparseIntent,
  SPARSE_INTENT_JSON_KIND,
} from '../../src/agent/sessions/sparse_intent.ts'
import { skeletonPass } from '../../src/agent/sessions/skeleton_pass.ts'
import {
  SPARSE_INTENT_FORCE_STOP_UNCERTAINTY,
  SPARSE_INTENT_MAX_ROUNDS,
  SPARSE_INTENT_MAX_SEGMENTS_READ,
  SPARSE_INTENT_MAX_TOKENS,
  SPARSE_INTENT_ROUND_SAMPLE_SIZE,
} from '../../src/constant/window.ts'
import type { AgentView } from '../../src/types/agent_view.ts'
import type { RawTrace } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

function card(
  id: string,
  refs: string[],
  opts: Partial<SegmentCard> = {},
): SegmentCard {
  return {
    id,
    tool: opts.tool ?? 'Bash',
    sig: opts.sig ?? `Bash:${id}`,
    outcome: opts.outcome ?? 'ok',
    rep_of: opts.rep_of ?? null,
    reads: [],
    writes: [],
    tokens: 3,
    focus: 'card',
    head: opts.head ?? id,
    raw_refs: refs,
  }
}

function fixture(): { raw: RawTrace; view: AgentView } {
  const raw: RawTrace = {
    meta: {
      trace_id: 't-sparse',
      source: 'claude-code',
      ground_truth_ref: 'g',
      total_tokens: 40,
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
    turns: [
      { id: 'head-1', role: 'user', content: 'HEAD_TASK_FIX_ADD', tokens: 2 },
      { id: 'h2', role: 'assistant', content: 'ok', tokens: 1 },
      { id: 'e1', role: 'tool_result', content: 'error boom', tokens: 2 },
      { id: 'e2', role: 'tool_result', content: 'error again', tokens: 2 },
      { id: 'mid', role: 'assistant', content: 'MIDDLE_SECRET_SHOULD_STAY_OUT', tokens: 4 },
      { id: 'ver-1', role: 'tool_result', content: 'VERIFY_PYTEST_PASSED', tokens: 2 },
      { id: 'tail', role: 'assistant', content: 'done', tokens: 1 },
    ],
    anchor_turn_ids: ['head-1', 'ver-1'],
  }
  const view: AgentView = {
    meta: raw.meta,
    intent_hypothesis: { version: 0, text: '' },
    skeleton: { version: 0, nodes: [] },
    segments: [
      card('s0001', ['head-1'], { tool: 'User', head: 'HEAD_TASK_FIX_ADD' }),
      card('s0002', ['h2'], { head: 'plan' }),
      card('s0003', ['e1'], { outcome: 'error', head: 'error boom' }),
      card('s0004', ['e2'], { outcome: 'error', head: 'error again', rep_of: 's0003' }),
      card('s0005', ['mid'], { head: 'middle' }),
      card('s0006', ['ver-1'], { head: 'VERIFY_PYTEST_PASSED' }),
      card('s0007', ['tail'], { head: 'done' }),
    ],
  }
  return { raw, view }
}

function fakeResult(
  json: unknown,
  opts: { tool_calls?: SessionPromptResult['tool_calls']; input_tokens?: number } = {},
): SessionPromptResult {
  return {
    text: JSON.stringify(json),
    json,
    tool_calls: opts.tool_calls ?? [],
    usage: {
      role: 'hole_a_skeleton',
      input_tokens: opts.input_tokens ?? 20,
      output_tokens: 8,
    },
  }
}

describe('candidate_pool', () => {
  it('stratifies head, verification, error/retry, failure-dense — not pure random', () => {
    const { raw, view } = fixture()
    const pool = buildCandidatePool({
      view,
      raw,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
    })
    const byId = new Map(pool.map((e) => [e.segment_id, e]))
    assert.equal(byId.get('s0001')?.stratum, 'head')
    assert.equal(byId.get('s0006')?.stratum, 'verification')
    assert.ok(
      byId.get('s0003')?.stratum === 'error_retry' ||
        byId.get('s0003')?.stratum === 'tool_failure_dense',
    )
    assert.equal(byId.get('s0004')?.stratum, 'error_retry')
    assert.ok(pool.some((e) => e.stratum === 'random_fill' || e.segment_id === 's0005'))
    // weights: anchors > random_fill
    const headW = byId.get('s0001')!.weight
    const fill = pool.find((e) => e.stratum === 'random_fill')
    if (fill !== undefined) assert.ok(headW > fill.weight)
  })

  it('gap-weighted sample prefers gap segment_ids on second draw', () => {
    const pool: CandidateEntry[] = [
      { segment_id: 'a', stratum: 'random_fill', weight: 1 },
      { segment_id: 'b', stratum: 'random_fill', weight: 1 },
      { segment_id: 'gap-target', stratum: 'random_fill', weight: 1 },
      { segment_id: 'c', stratum: 'random_fill', weight: 1 },
    ]
    const picked = sampleCandidates(pool, {
      already_read: new Set(['a']),
      count: 2,
      gaps: [{ hint: 'need mid', segment_ids: ['gap-target'], weight: 5 }],
      rng: () => 0.99, // would otherwise pick late ids; gap ids forced first
    })
    assert.equal(picked[0], 'gap-target')
  })
})

describe('sparse_intent parse / boundary', () => {
  it('rejects keep/collapse/drop from Hole A structured output', () => {
    assert.throws(
      () =>
        parseSparseIntentJson({
          kind: SPARSE_INTENT_JSON_KIND,
          enough: true,
          intent_v0: 'x',
          scenario: 'implement',
          skeleton_points: [],
          uncertainty: 0.1,
          keep: ['s0001'],
        }),
      /must not emit cut field/,
    )
    assert.throws(
      () =>
        assertNoCutActions({
          skeleton_points: [{ id: 'n1', kind: 'turning_point', segment_ids: ['s1'], action: 'drop' }],
        }),
      /keep\/collapse\/drop/,
    )
  })

  it('accepts legacy skeleton_pass_v0 as enough=true', () => {
    const parsed = parseSparseIntentJson({
      kind: 'skeleton_pass_v0',
      intent: { text: 'Fix add' },
      scenario: 'test_fix',
      skeleton: {
        nodes: [{ id: 'n1', kind: 'turning_point', segment_ids: ['s0002'], note: 'x' }],
      },
    })
    assert.equal(parsed.enough, true)
    assert.equal(parsed.intent_v0, 'Fix add')
    assert.equal(parsed.scenario, 'test_fix')
    assert.equal(parsed.skeleton_points[0]?.id, 'n1')
  })
})

describe('sparse_intent loop', () => {
  it('multi-round: not enough → gaps → enough with skeleton_points only', async () => {
    const { raw, view } = fixture()
    let call = 0
    const fake = new FakeSessionBackend((input: SessionPromptInput) => {
      call += 1
      if (call === 1) {
        return fakeResult({
          kind: SPARSE_INTENT_JSON_KIND,
          enough: false,
          intent_v0: 'partial',
          scenario: 'implement',
          skeleton_points: [],
          uncertainty: 0.6,
          gaps: [{ hint: 'need error cluster', segment_ids: ['s0003', 's0004'], strata: ['error_retry'] }],
        })
      }
      return fakeResult({
        kind: SPARSE_INTENT_JSON_KIND,
        enough: true,
        intent_v0: 'Fix add so tests pass',
        scenario: 'test_fix',
        skeleton_points: [
          {
            id: 'n1',
            kind: 'turning_point',
            segment_ids: ['s0003'],
            note: 'error then recover',
          },
          {
            id: 'n2',
            kind: 'verification_anchor',
            segment_ids: ['s0006'],
            note: 'pytest',
          },
        ],
        uncertainty: 0.2,
      })
    })

    const out = await sparseIntent({
      trace_id: raw.meta.trace_id,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
      raw,
      view,
      backend: fake,
    })

    assert.equal(out.enough, true)
    assert.equal(out.force_stopped, false)
    assert.ok(out.rounds >= 2)
    assert.equal(out.scenario, 'test_fix')
    assert.equal(out.skeleton.nodes.length, 2)
    assert.equal(out.intent.text, 'Fix add so tests pass')
    // Second prompt should mention gap ids
    const second = fake.calls[1]?.composed ?? ''
    assert.match(second, /s0003/)
    assert.doesNotMatch(second, /MIDDLE_SECRET_SHOULD_STAY_OUT/)
    // No cut decisions
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'keep'), false)
  })

  it('gap-weighted second round includes gap segment in sample_batch', async () => {
    const { raw, view } = fixture()
    let call = 0
    const fake = new FakeSessionBackend(() => {
      call += 1
      if (call === 1) {
        return fakeResult({
          kind: SPARSE_INTENT_JSON_KIND,
          enough: false,
          intent_v0: 'partial',
          scenario: 'implement',
          skeleton_points: [],
          uncertainty: 0.7,
          gaps: [{ hint: 'read middle', segment_ids: ['s0005'] }],
        })
      }
      return fakeResult({
        kind: SPARSE_INTENT_JSON_KIND,
        enough: true,
        intent_v0: 'ok',
        scenario: 'implement',
        skeleton_points: [
          { id: 'n1', kind: 'main_path_hypothesis', segment_ids: ['s0005'], note: 'mid' },
        ],
        uncertainty: 0.2,
      })
    })

    await sparseIntent({
      trace_id: raw.meta.trace_id,
      raw,
      view,
      backend: fake,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
      rng: () => 0.5,
    })

    const secondText = fake.calls[1]?.input.text ?? ''
    assert.match(secondText, /sample_batch_segment_ids/)
    assert.match(secondText, /s0005/)
  })

  it('hard budget force-stop still emits best-effort + high uncertainty', async () => {
    const { raw, view } = fixture()
    const fake = new FakeSessionBackend(() =>
      fakeResult({
        kind: SPARSE_INTENT_JSON_KIND,
        enough: false,
        intent_v0: 'still unsure',
        scenario: 'investigate',
        skeleton_points: [
          { id: 'n0', kind: 'main_path_hypothesis', segment_ids: ['s0001'], note: 'head only' },
        ],
        uncertainty: 0.4,
        gaps: [{ hint: 'more', segment_ids: ['s0007'] }],
      }),
    )

    const out = await sparseIntent({
      trace_id: raw.meta.trace_id,
      raw,
      view,
      backend: fake,
      max_rounds: 1,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
    })

    assert.equal(out.enough, false)
    assert.equal(out.force_stopped, true)
    assert.ok(out.uncertainty >= SPARSE_INTENT_FORCE_STOP_UNCERTAINTY)
    assert.equal(out.intent.text, 'still unsure')
    assert.equal(out.skeleton.nodes[0]?.id, 'n0')
    assert.ok((out.notes ?? []).some((n) => n.includes('max_rounds') || n.includes('budget')))
  })

  it('Hole A path never registers keep/label tools; skeletonPass wires sparse fields', async () => {
    const { raw, view } = fixture()
    const fake = new FakeSessionBackend(() =>
      fakeResult({
        kind: SPARSE_INTENT_JSON_KIND,
        enough: true,
        intent_v0: 'Fix add',
        scenario: 'test_fix',
        skeleton_points: [
          { id: 'n1', kind: 'turning_point', segment_ids: ['s0002'], note: 'edit' },
        ],
        uncertainty: 0.15,
      }),
    )
    const out = await skeletonPass({
      trace_id: raw.meta.trace_id,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
      raw,
      view,
      backend: fake,
    })
    assert.equal(out.enough, true)
    assert.equal(out.force_stopped, false)
    assert.equal(out.skeleton.nodes[0]?.kind, 'turning_point')
    assert.deepEqual(fake.calls[0]?.tools, ['read_segment'])
    const composed = fake.calls[0]?.composed ?? ''
    assert.match(composed, /sparse_intent_v0/)
    assert.doesNotMatch(composed, /\bkeep_segment\b/)
    assert.doesNotMatch(composed, /\blabel_segment\b/)
    assert.doesNotMatch(composed, /MIDDLE_SECRET_SHOULD_STAY_OUT/)
  })
})

describe('sparse_intent constants', () => {
  it('locks ADR-0011 hard budget numbers', () => {
    assert.equal(SPARSE_INTENT_MAX_ROUNDS, 3)
    assert.equal(SPARSE_INTENT_MAX_SEGMENTS_READ, 12)
    assert.equal(SPARSE_INTENT_MAX_TOKENS, 8_000)
    assert.equal(SPARSE_INTENT_ROUND_SAMPLE_SIZE, 4)
    assert.equal(SPARSE_INTENT_FORCE_STOP_UNCERTAINTY, 0.85)
  })
})
