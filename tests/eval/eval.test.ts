import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FakeSessionBackend,
  composeSessionPrompt,
  setSessionBackend,
} from '../../src/agent/sessions/open_session.ts'
import { runQa } from '../../src/agent/sessions/l4_qa.ts'
import { runReplay } from '../../src/agent/sessions/l4_replay.ts'
import {
  assertBlindReviewPrompt,
  composeReviewPrompt,
  runBlindReview,
} from '../../src/agent/sessions/l4_review.ts'
import { BENCHMARK_PASS } from '../../src/constant/compression.ts'
import {
  compressionRatio,
  compressionScore,
  computeDistillMetrics,
  compositeScore,
  m1Score,
  distillCostRatio,
  keyStepRecall,
  qaRatio,
  sixMetricsPassed,
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
const pipelineSrc = join(dirname(fileURLToPath(import.meta.url)), '../../src/pipeline/orchestrator.ts')

afterEach(() => {
  setSessionBackend(undefined)
})

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


  it('fluff-like short trace passes cost when hole A+B usage is real and light (not estimate)', () => {
    // sess-short-fluff: original≈4533, compress≈0.015 → removed≈4464.
    // Overnight mint failed at ≈0.598 because estimateTokens(composed)≈2668.
    // With real mint usage (pi Usage.input/output) holes can stay ≤0.3×removed.
    const original = 4533
    const cut = Math.round(original * 0.015221707478491065)
    const removed = original - cut
    const lightHole = 900 // plausible real hole A+B when usage is read
    const heavyEstimate = 2668
    assert.ok(distillCostRatio({ hole_a_plus_b_tokens: lightHole, tokens_removed: removed }) <= 0.3)
    assert.ok(distillCostRatio({ hole_a_plus_b_tokens: heavyEstimate, tokens_removed: removed }) > 0.3)
    assert.equal(
      computeDistillMetrics({
        raw: { meta: { total_tokens: original } },
        training: { turns: [{ tokens: cut }] },
        view: { segments: [1] },
        decisions: [],
        warrant: { entries: [] },
        hole_a_plus_b_tokens: lightHole,
      }).distill_cost_ratio,
      lightHole / removed,
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

describe('six-metric pure functions', () => {
  it('compressionScore maps knots and does not reward cutting to 0%', () => {
    assert.equal(compressionScore(0.3), 60)
    assert.equal(compressionScore(0.15), 90)
    assert.equal(compressionScore(0.05), 100)
    assert.equal(compressionScore(0), 0)
    assert.ok(compressionScore(0.2) > 60)
    assert.ok(compressionScore(0.2) < 90)
  })

  it('keyStepRecall is kept/gold and empty gold is 0', () => {
    assert.equal(keyStepRecall({ gold_segment_ids: ['a', 'b'], kept: ['a', 'c'] }), 0.5)
    assert.equal(keyStepRecall({ gold_segment_ids: [], kept: ['a'] }), 0)
  })

  it('compositeScore is 0 unless all six pass; missing stays null', () => {
    const passing = {
      compression_ratio: 0.2,
      key_step_recall: 0.96,
      replay: 0.95,
      qa: 0.9,
      coherence_scores: [4, 5, 4],
      distill_cost_ratio: 0.2,
    }
    assert.equal(sixMetricsPassed(passing), true)
    const score = compositeScore(passing)
    assert.ok(score !== null)
    assert.equal(score, compressionScore(0.2) * 0.96 * 0.95)
    assert.equal(compositeScore({ ...passing, replay: 0.1 }), 0)
    assert.equal(
      compositeScore({ ...passing, key_step_recall: null }),
      null,
    )
    assert.ok(BENCHMARK_PASS.qa_min <= passing.qa)
  })

  it('m1Score is compress x recall only; cost fail does not zero M1', () => {
    const base = {
      compression_ratio: 0.2,
      key_step_recall: 0.96,
      replay: 0.95,
      qa: 0.9,
      coherence_scores: [4, 5, 4],
      distill_cost_ratio: 1.62,
    }
    assert.equal(sixMetricsPassed(base), false, 'cost>0.3 fails full composite')
    assert.equal(compositeScore(base), 0)
    assert.equal(m1Score(base), compressionScore(0.2) * 0.96)
    assert.equal(m1Score({ ...base, compression_ratio: 0.9 }), 0)
    assert.equal(m1Score({ ...base, key_step_recall: 0.5 }), 0)
    assert.equal(m1Score({ ...base, key_step_recall: null }), null)
    assert.equal(m1Score({ compression_ratio: 0.9, key_step_recall: null }), 0)
  })
})

describe('eval L4 via fake backend', () => {
  const playback = {
    trace_id: 't',
    plan_ref: 'p',
    cards: [
      {
        id: 's0001',
        tool: 'Edit',
        sig: 'Edit:a',
        outcome: 'ok' as const,
        rep_of: null,
        reads: [],
        writes: [],
        tokens: 1,
        focus: 'card' as const,
        head: 'edit add',
        raw_refs: ['t1'],
      },
    ],
    collapsed: [],
  }
  const intent = { version: 0, text: 'Fix add' }
  const plan = {
    trace_id: 't',
    profile_id: 'default',
    warrant_ref: 'w',
    kept: ['s0001'],
    collapsed: [],
    dropped: [],
    span_ok: true,
    span_violations: [],
  }

  it('runQa / answerQa / generateQa parse fake JSON and do not import pi', async () => {
    const fake = new FakeSessionBackend()
    const qa = await runQa({
      intent,
      playback,
      questions: [{ id: 'q1', question: 'What failed?' }],
      backend: fake,
    })
    assert.equal(qa.score.answered, 1)
    assert.equal(qa.score.correct, 1)
    assert.equal(qaRatio(qa.score), 1)
    assert.equal(fake.calls[0]?.role, 'l4_qa')
    assert.equal(qa.usage.role, 'l4_qa')

    const gen = await generateQa(
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
        intent_hypothesis: intent,
        skeleton: { version: 0, nodes: [] },
        segments: playback.cards,
      },
      { backend: fake, playback },
    )
    assert.ok(gen.length >= 1)
    const scored = await answerQa(playback, gen, { intent, backend: fake })
    assert.ok(scored.answered >= 1)

    for (const name of ['metrics.ts', 'review.ts', 'review_fill.ts', 'replay.ts', 'run.ts']) {
      const src = readFileSync(join(evalDir, name), 'utf8')
      assert.doesNotMatch(src, /@mariozechner\/pi/)
      assert.doesNotMatch(src, /createAgentSession/)
    }
  })

  it('runReplay is a clean session and eval.replay wires the score', async () => {
    const fake = new FakeSessionBackend()
    const out = await runReplay({
      task: { trace_id: 't', text: 'Fix add' },
      playback,
      backend: fake,
    })
    assert.equal(out.success, true)
    assert.equal(fake.calls[0]?.role, 'l4_replay')
    const composed = fake.calls[0]?.composed ?? ''
    assert.match(composed, /clean session/i)
    assert.match(composed, /Do not proxy/)
    assert.doesNotMatch(composed, /warrant/)
    const wired = await replay({ trace_id: 't', text: 'Fix add' }, plan, {
      playback,
      backend: fake,
    })
    assert.equal(wired.success, true)
  })

  it('review prompt has no warrant/skeleton; blindReview still fills from skeleton in code', async () => {
    const fake = new FakeSessionBackend()
    const prompt = composeReviewPrompt({ intent, playback })
    const composed = composeSessionPrompt(prompt)
    assertBlindReviewPrompt(composed)
    assert.doesNotMatch(composed, /warrant/i)
    assert.doesNotMatch(composed, /skeleton/i)
    assert.match(composed, /Fix add/)
    assert.match(composed, /s0001/)

    const session = await runBlindReview({ intent, playback, backend: fake })
    assert.equal(fake.calls[0]?.role, 'l4_review')
    assert.deepEqual(session.answer.turning_point_segment_ids, ['s0001'])
    assertBlindReviewPrompt(fake.calls[0]?.composed ?? '')

    const reviewed = await blindReview({
      intent,
      playback,
      skeleton: {
        version: 1,
        nodes: [
          { id: 'n1', kind: 'turning_point', segment_ids: ['s0001'], note: '' },
          { id: 'n2', kind: 'verification_anchor', segment_ids: ['s0009'], note: '' },
        ],
      },
      backend: fake,
    })
    assert.equal(reviewed.passed, false)
    assert.deepEqual(reviewed.fill_in_segment_ids, ['s0009'])
    assert.ok(reviewed.answer)
    assert.equal(
      (fake.calls.at(-1)?.composed ?? '').includes('s0009'),
      false,
      'dropped skeleton node must not be injected into the review session',
    )
  })

  it('orchestrator does not import L4 session runners', () => {
    const src = readFileSync(pipelineSrc, 'utf8')
    assert.doesNotMatch(src, /l4_qa/)
    assert.doesNotMatch(src, /l4_replay/)
    assert.doesNotMatch(src, /l4_review/)
    assert.doesNotMatch(src, /\brunQa\b/)
    assert.doesNotMatch(src, /\brunReplay\b/)
    assert.doesNotMatch(src, /\brunBlindReview\(/)
    assert.doesNotMatch(src, /TRACE_DISTILLER_MODEL_L4/)
    assert.match(src, /reviewAgainstPlan/)
    assert.match(src, /review_fill/)
    assert.doesNotMatch(src, /eval\/review\.ts/)
  })
})
