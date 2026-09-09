import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NotImplementedError } from '../../src/agent/sessions/skeleton_pass.ts'
import {
  compressionRatio,
  computeDistillMetrics,
  distillCostRatio,
} from '../../src/eval/metrics.ts'
import { replay } from '../../src/eval/replay.ts'
import { REVIEW_MAX_ROUNDS } from '../../src/constant/window.ts'
import {
  answerQa,
  blindReview,
  generateQa,
  reviewAgainstPlan,
  reviewFillInIds,
} from '../../src/eval/review.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/eval')

describe('eval ratios', () => {
  it('compressionRatio is cut / original', () => {
    assert.equal(compressionRatio({ original_tokens: 1000, cut_tokens: 200 }), 0.2)
    assert.equal(compressionRatio({ original_tokens: 1000, cut_tokens: 0 }), 0)
    assert.equal(compressionRatio({ original_tokens: 0, cut_tokens: 10 }), 0)
  })

  it('distillCostRatio is hole A+B / removed and excludes L4 by input shape', () => {
    assert.equal(
      distillCostRatio({ hole_a_plus_b_tokens: 50_000, tokens_removed: 200_000 }),
      0.25,
    )
    assert.equal(distillCostRatio({ hole_a_plus_b_tokens: 0, tokens_removed: 10 }), 0)
    assert.equal(
      distillCostRatio({ hole_a_plus_b_tokens: 8, tokens_removed: 0 }),
      Number.POSITIVE_INFINITY,
    )
    const l4 = 9_999
    const holes = 40
    assert.equal(
      distillCostRatio({ hole_a_plus_b_tokens: holes, tokens_removed: 100 }),
      0.4,
    )
    assert.notEqual(
      distillCostRatio({ hole_a_plus_b_tokens: holes + l4, tokens_removed: 100 }),
      0.4,
    )
  })

  it('computeDistillMetrics aggregates compression, rule coverage, llm fraction, fail_closed', () => {
    const metrics = computeDistillMetrics({
      raw: { meta: { total_tokens: 100 } },
      training: { turns: [{ tokens: 20 }, { tokens: 10 }] },
      view: { segments: [1, 2, 3, 4] },
      decisions: [
        { source: { kind: 'rule', name: 'repeat_read' } },
        { source: { kind: 'rule', name: 'repeat_read' } },
        { source: { kind: 'llm', name: 'implement' } },
      ],
      warrant: {
        entries: [
          { source: { name: 'repeat_read' } },
          { source: { name: 'fail_closed_keep' } },
        ],
      },
      hole_a_plus_b_tokens: 7,
    })
    assert.equal(metrics.compression_ratio, 0.3)
    assert.equal(metrics.distill_cost_ratio, 7 / 70)
    assert.equal(metrics.total_segments, 4)
    assert.equal(metrics.ruled_count, 2)
    assert.equal(metrics.llm_count, 1)
    assert.equal(metrics.rule_coverage, 0.5)
    assert.equal(metrics.llm_segment_fraction, 0.25)
    assert.equal(metrics.fail_closed_count, 1)
  })
})

describe('blind review protocol helpers', () => {
  it('fills keep ids for skeleton nodes missing from playback, max rounds is 2', () => {
    assert.equal(REVIEW_MAX_ROUNDS, 2)
    const fill = reviewFillInIds(
      {
        version: 1,
        nodes: [
          { id: 'n1', kind: 'turning_point', segment_ids: ['s0002'], note: '' },
          { id: 'n2', kind: 'verification_anchor', segment_ids: ['s0009'], note: '' },
        ],
      },
      {
        trace_id: 't',
        plan_ref: 'p',
        cards: [
          {
            id: 's0002',
            tool: 'Edit',
            sig: 'Edit:a',
            outcome: 'ok',
            rep_of: null,
            reads: [],
            writes: [],
            tokens: 1,
            focus: 'card',
            head: 'kept',
            raw_refs: ['t2'],
          },
        ],
        collapsed: [],
      },
    )
    assert.deepEqual(fill, ['s0009'])
  })

  it('reviewAgainstPlan fills keep ids from plan without calling L4', () => {
    const result = reviewAgainstPlan(
      {
        version: 1,
        nodes: [
          { id: 'n1', kind: 'turning_point', segment_ids: ['s0002'], note: '' },
          { id: 'n2', kind: 'verification_anchor', segment_ids: ['s0009'], note: '' },
        ],
      },
      {
        trace_id: 't',
        profile_id: 'default',
        warrant_ref: 'w',
        kept: ['s0002'],
        collapsed: [],
        dropped: ['s0009'],
        span_ok: true,
        span_violations: [],
      },
    )
    assert.equal(result.passed, false)
    assert.deepEqual(result.missing_skeleton_nodes, ['n2'])
    assert.deepEqual(result.fill_in_segment_ids, ['s0009'])
  })
})

describe('eval review / replay shells', () => {
  it('throws NotImplementedError and does not import pi', async () => {
    await assert.rejects(
      () =>
        blindReview({
          intent: { version: 0, text: '' },
          playback: { trace_id: 't', plan_ref: 'p', cards: [], collapsed: [] },
          skeleton: { version: 0, nodes: [] },
        }),
      (err: unknown) => err instanceof NotImplementedError,
    )
    await assert.rejects(
      () => replay({ trace_id: 't' }, {
        trace_id: 't',
        profile_id: 'default',
        warrant_ref: 'w',
        kept: [],
        collapsed: [],
        dropped: [],
        span_ok: true,
        span_violations: [],
      }),
      (err: unknown) => err instanceof NotImplementedError,
    )
    await assert.rejects(
      () =>
        generateQa(
          {
            meta: {
              trace_id: 't',
              source: 'claude-code',
              ground_truth_ref: 'g',
              total_tokens: 1,
            },
            ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
            turns: [],
            anchor_turn_ids: [],
          },
          {
            meta: {
              trace_id: 't',
              source: 'claude-code',
              ground_truth_ref: 'g',
              total_tokens: 1,
            },
            intent_hypothesis: { version: 0, text: '' },
            skeleton: { version: 0, nodes: [] },
            segments: [],
          },
        ),
      (err: unknown) => err instanceof NotImplementedError,
    )
    await assert.rejects(
      () => answerQa({ trace_id: 't', plan_ref: 'p', turns: [] }, []),
      (err: unknown) => err instanceof NotImplementedError,
    )

    for (const name of ['metrics.ts', 'review.ts', 'replay.ts']) {
      const src = readFileSync(join(evalDir, name), 'utf8')
      assert.doesNotMatch(src, /@mariozechner\/pi/)
      assert.doesNotMatch(src, /createAgentSession/)
    }
  })
})
