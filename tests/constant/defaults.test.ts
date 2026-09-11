import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BENCHMARK_PASS,
  COMPRESSION_SCORE_KNOTS,
  COST_SOFT_ORIGINAL_TOKENS,
  DEAD_END_MAX_REPRESENTATIVE,
  DEAD_END_SUMMARY_MAX_CHARS,
  DEFAULT_CUT_PROFILE,
  KEEP_RATIO_FLOOR,
  KEEP_FLOOR_MIN_ORIGINAL_TOKENS,
  KEEP_RATIO_SOFT_CAP,
  LONG_CUT_PROFILE,
  LONG_DEAD_END_MAX_REPRESENTATIVE,
  LONG_LABEL_WINDOW_SIZE,
  LONG_SPAN_MAX_GAP_SEGMENTS,
  MULTI_DEAD_END_CUT_PROFILE,
  SHORT_CUT_PROFILE,
  SHORT_DEAD_END_MAX_REPRESENTATIVE,
  SHORT_LABEL_WINDOW_SIZE,
  cutProfileForBin,
} from '../../src/constant/compression.ts'
import { DEFAULT_SCENARIO, resolveSkillRoute, SKILL_ROUTE } from '../../src/constant/skill_route.ts'
import {
  CARD_INDEX_CHARS_PER_SEGMENT_MAX,
  CARD_INDEX_HEAD_MAX_CHARS,
  FAIL_CLOSED_KEEP,
  CUT_BRAIN_FOCUS_SLOT,
  CUT_BRAIN_LOW_CONFIDENCE,
  CUT_BRAIN_MAX_ROUNDS,
  CUT_BRAIN_PER_SEGMENT_DISCLOSE_CAP,
  CUT_BRAIN_ROUNDS_PER_UNRESOLVED,
  CUT_BRAIN_SCHEMA_RETRIES,
  EVIDENCE_CARD_KINDS,
  KEEP_EVIDENCE_BITS,
  LABEL_WINDOW_SIZE,
  S2_EVIDENCE_CARD_TOKEN_CAP,
  PI_FAILURE_RETRY,
  REVIEW_MAX_ROUNDS,
  SEGMENT_HEAD_MAX_CHARS,
  SESSION_CALL_TIMEOUT_MS,
  SESSION_TIMEOUT_ENV,
  SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD,
  SKELETON_TURN_CONTENT_MAX_CHARS,
  SPAN_MAX_GAP_SEGMENTS,
  SPARSE_INTENT_FORCE_STOP_UNCERTAINTY,
  SPARSE_INTENT_MAX_ROUNDS,
  SPARSE_INTENT_MAX_SEGMENTS_READ,
  SPARSE_INTENT_MAX_TOKENS,
  SPARSE_INTENT_ROUND_SAMPLE_SIZE,
} from '../../src/constant/window.ts'
import { SCENARIOS } from '../../src/enums/scenario.ts'

describe('locked defaults', () => {
  it('locks window, span, jaccard, head, dead-end, review, and retry numbers', () => {
    assert.equal(LABEL_WINDOW_SIZE, 8)
    assert.equal(CUT_BRAIN_MAX_ROUNDS, 256)
    assert.equal(CUT_BRAIN_ROUNDS_PER_UNRESOLVED, 2)
    assert.equal(CUT_BRAIN_PER_SEGMENT_DISCLOSE_CAP, 2)
    assert.equal(CUT_BRAIN_FOCUS_SLOT, 1)
    assert.equal(S2_EVIDENCE_CARD_TOKEN_CAP, 256)
    assert.equal(CUT_BRAIN_LOW_CONFIDENCE, 0.5)
    assert.equal(CUT_BRAIN_SCHEMA_RETRIES, 1)
    assert.deepEqual([...KEEP_EVIDENCE_BITS], ['skeleton_hit', 'key_decision_flag'])
    assert.deepEqual([...EVIDENCE_CARD_KINDS], ['structure', 'headtail', 'error'])
    assert.equal(SPARSE_INTENT_MAX_ROUNDS, 3)
    assert.equal(SPARSE_INTENT_MAX_SEGMENTS_READ, 12)
    assert.equal(SPARSE_INTENT_MAX_TOKENS, 8_000)
    assert.equal(SPARSE_INTENT_ROUND_SAMPLE_SIZE, 4)
    assert.equal(SPARSE_INTENT_FORCE_STOP_UNCERTAINTY, 0.85)
    assert.equal(SPAN_MAX_GAP_SEGMENTS, 3)
    assert.equal(SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD, 0.8)
    assert.equal(SEGMENT_HEAD_MAX_CHARS, 120)
    assert.equal(CARD_INDEX_HEAD_MAX_CHARS, 40)
    assert.ok(CARD_INDEX_HEAD_MAX_CHARS < SEGMENT_HEAD_MAX_CHARS)
    assert.equal(SKELETON_TURN_CONTENT_MAX_CHARS, 200)
    assert.equal(CARD_INDEX_CHARS_PER_SEGMENT_MAX, 220)
    assert.equal(DEAD_END_MAX_REPRESENTATIVE, 3)
    assert.equal(DEAD_END_SUMMARY_MAX_CHARS, 80)
    assert.equal(REVIEW_MAX_ROUNDS, 2)
    assert.equal(KEEP_RATIO_FLOOR, 0.08)
    assert.equal(KEEP_FLOOR_MIN_ORIGINAL_TOKENS, 5_000)
    assert.equal(KEEP_RATIO_SOFT_CAP, 0.15)
    assert.equal(COST_SOFT_ORIGINAL_TOKENS, 25_000)
    assert.equal(PI_FAILURE_RETRY, 1)
    assert.equal(SESSION_CALL_TIMEOUT_MS, 120_000)
    assert.equal(SESSION_TIMEOUT_ENV, 'TRACE_DISTILLER_SESSION_TIMEOUT_MS')
    assert.equal(FAIL_CLOSED_KEEP, true)
    assert.deepEqual(DEFAULT_CUT_PROFILE.collapse_labels, ['dead_end', 'collapse_uncertain'])
    assert.equal(DEFAULT_CUT_PROFILE.span.max_gap_segments, 3)
    assert.equal(DEFAULT_CUT_PROFILE.dead_end.max_representative, 3)
    assert.equal(DEFAULT_CUT_PROFILE.dead_end.summary_max_chars, 80)
    assert.equal(SHORT_DEAD_END_MAX_REPRESENTATIVE, 5)
    assert.equal(LONG_DEAD_END_MAX_REPRESENTATIVE, 2)
    assert.equal(SHORT_LABEL_WINDOW_SIZE, 8)
    assert.equal(LONG_LABEL_WINDOW_SIZE, 6)
    assert.equal(SHORT_CUT_PROFILE.dead_end.max_representative, 5)
    assert.equal(SHORT_CUT_PROFILE.keep_ratio_floor, null)
    assert.equal(LONG_CUT_PROFILE.dead_end.max_representative, 2)
    assert.equal(LONG_CUT_PROFILE.keep_ratio_floor, 0.08)
    assert.equal(LONG_SPAN_MAX_GAP_SEGMENTS, 12)
    assert.equal(LONG_CUT_PROFILE.span.max_gap_segments, 12)
    assert.equal(MULTI_DEAD_END_CUT_PROFILE.span.max_gap_segments, 12)
    assert.equal(MULTI_DEAD_END_CUT_PROFILE.dead_end.max_representative, 3)
    assert.equal(cutProfileForBin('short').id, 'bin:short')
    assert.equal(cutProfileForBin('long').id, 'bin:long')
    assert.equal(cutProfileForBin('multi_dead_end').id, 'bin:multi_dead_end')
    assert.equal(BENCHMARK_PASS.compression_ratio_max, 0.3)
    assert.equal(BENCHMARK_PASS.key_step_recall_min, 0.95)
    assert.equal(BENCHMARK_PASS.replay_min, 0.9)
    assert.equal(BENCHMARK_PASS.qa_min, 0.85)
    assert.equal(BENCHMARK_PASS.coherence_mean_min, 4)
    assert.equal(BENCHMARK_PASS.coherence_item_min, 2)
    assert.equal(BENCHMARK_PASS.distill_cost_ratio_max, 0.3)
    assert.deepEqual(
      COMPRESSION_SCORE_KNOTS.map((k) => k.ratio),
      [0, 0.05, 0.15, 0.3, 1],
    )
  })

  it('routes five scenarios and falls back to implement', () => {
    assert.deepEqual([...SCENARIOS], [
      'debug',
      'implement',
      'refactor',
      'test_fix',
      'investigate',
    ])
    assert.equal(DEFAULT_SCENARIO, 'implement')
    assert.equal(resolveSkillRoute('debug').path, SKILL_ROUTE.debug)
    assert.equal(resolveSkillRoute('debug').fallback, false)
    const miss = resolveSkillRoute('unknown')
    assert.deepEqual(miss, {
      scenario: 'implement',
      path: 'agent/skills/implement.md',
      fallback: true,
    })
    assert.equal(resolveSkillRoute(undefined).fallback, true)
    assert.notEqual(resolveSkillRoute('refactor').path, '')
  })
})
