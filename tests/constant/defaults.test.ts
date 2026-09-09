import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEAD_END_MAX_REPRESENTATIVE,
  DEAD_END_SUMMARY_MAX_CHARS,
  DEFAULT_CUT_PROFILE,
} from '../../src/constant/compression.ts'
import { DEFAULT_SCENARIO, resolveSkillRoute, SKILL_ROUTE } from '../../src/constant/skill_route.ts'
import {
  FAIL_CLOSED_KEEP,
  LABEL_WINDOW_SIZE,
  PI_FAILURE_RETRY,
  REVIEW_MAX_ROUNDS,
  SEGMENT_HEAD_MAX_CHARS,
  SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD,
  SPAN_MAX_GAP_SEGMENTS,
} from '../../src/constant/window.ts'
import { SCENARIOS } from '../../src/enums/scenario.ts'

describe('locked defaults', () => {
  it('locks window, span, jaccard, head, dead-end, review, and retry numbers', () => {
    assert.equal(LABEL_WINDOW_SIZE, 8)
    assert.equal(SPAN_MAX_GAP_SEGMENTS, 3)
    assert.equal(SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD, 0.8)
    assert.equal(SEGMENT_HEAD_MAX_CHARS, 120)
    assert.equal(DEAD_END_MAX_REPRESENTATIVE, 3)
    assert.equal(DEAD_END_SUMMARY_MAX_CHARS, 80)
    assert.equal(REVIEW_MAX_ROUNDS, 2)
    assert.equal(PI_FAILURE_RETRY, 1)
    assert.equal(FAIL_CLOSED_KEEP, true)
    assert.equal(DEFAULT_CUT_PROFILE.span.max_gap_segments, 3)
    assert.equal(DEFAULT_CUT_PROFILE.dead_end.max_representative, 3)
    assert.equal(DEFAULT_CUT_PROFILE.dead_end.summary_max_chars, 80)
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
