import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  composeSingleSlotText,
  evidenceCardWithinCap,
  isLowConfidence,
  isWriteOutlier,
  keepIsLegal,
  materializeEvidenceCard,
  overThresholdKeepRate,
  parseHoleBTurn,
  pickFocus,
  s2TokenCap,
  tokenMedian,
} from '../../src/agent/sessions/cut_brain_harness.ts'
import {
  CUT_BRAIN_FOCUS_SLOT,
  CUT_BRAIN_LOW_CONFIDENCE,
  EVIDENCE_CARD_KINDS,
  KEEP_EVIDENCE_BITS,
  S2_EVIDENCE_CARD_TOKEN_CAP,
} from '../../src/constant/window.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'
import type { IntentHypothesis } from '../../src/types/agent_view.ts'
import type { RawTrace } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

const here = dirname(fileURLToPath(import.meta.url))

function card(id: string, extra: Partial<SegmentCard> = {}): SegmentCard {
  return {
    id,
    tool: extra.tool ?? 'Read',
    sig: extra.sig ?? `Read:${id}`,
    outcome: extra.outcome ?? 'ok',
    rep_of: extra.rep_of ?? null,
    reads: extra.reads ?? [],
    writes: extra.writes ?? [],
    tokens: extra.tokens ?? 8,
    focus: extra.focus ?? 'card',
    head: extra.head ?? `head-${id}`,
    raw_refs: extra.raw_refs ?? [`t-${id}`],
  }
}

function rawFor(cards: SegmentCard[], body = 'short'): RawTrace {
  return {
    meta: {
      trace_id: 'h',
      source: 'claude-code',
      ground_truth_ref: 'g',
      total_tokens: 4,
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
    turns: cards.map((c) => ({
      id: c.raw_refs[0] ?? c.id,
      role: 'tool_call',
      content: body,
      tokens: c.tokens,
    })),
    anchor_turn_ids: [],
  }
}

describe('cut-brain harness predicates', () => {
  it('locks low confidence at < 0.5 and keep bits closed set', () => {
    assert.equal(CUT_BRAIN_LOW_CONFIDENCE, 0.5)
    assert.equal(isLowConfidence(0.49), true)
    assert.equal(isLowConfidence(0.5), false)
    assert.deepEqual([...KEEP_EVIDENCE_BITS], ['skeleton_hit', 'key_decision_flag'])
    assert.deepEqual([...EVIDENCE_CARD_KINDS], ['structure', 'headtail', 'error'])
    assert.equal(CUT_BRAIN_FOCUS_SLOT, 1)
  })

  it('rejects keep without bits or with low confidence; accepts skeleton_hit', () => {
    const skeleton = new Set(['s0001'])
    const missing = keepIsLegal({
      label: 'useful_exploration',
      confidence: 0.9,
      keep_bits: [],
      segment_id: 's0001',
      skeletonIds: skeleton,
      from_keep_segment: false,
    })
    assert.equal(missing.legal, false)
    const low = keepIsLegal({
      label: 'key_decision',
      confidence: 0.49,
      keep_bits: ['skeleton_hit'],
      segment_id: 's0001',
      skeletonIds: skeleton,
      from_keep_segment: false,
    })
    assert.equal(low.legal, false)
    const ok = keepIsLegal({
      label: 'key_decision',
      confidence: 0.5,
      keep_bits: ['skeleton_hit'],
      segment_id: 's0001',
      skeletonIds: skeleton,
      from_keep_segment: false,
    })
    assert.equal(ok.legal, true)
    const bogusHit = keepIsLegal({
      label: 'key_decision',
      confidence: 0.9,
      keep_bits: ['skeleton_hit'],
      segment_id: 's0009',
      skeletonIds: skeleton,
      from_keep_segment: false,
    })
    assert.equal(bogusHit.legal, false)
    const collapse = keepIsLegal({
      label: 'dead_end',
      confidence: 0.2,
      keep_bits: [],
      segment_id: 's0001',
      skeletonIds: skeleton,
      from_keep_segment: false,
    })
    assert.equal(collapse.legal, true)
  })

  it('pickFocus prefers large write outlier, then error, then normal', () => {
    const cards = [
      card('s0001', { tokens: 8 }),
      card('s0002', { outcome: 'error', tokens: 10 }),
      card('s0003', { tool: 'Write', writes: ['a.ts'], tokens: 400 }),
    ]
    const pick = pickFocus(['s0001', 's0002', 's0003'], cards, new Set())
    assert.equal(pick?.card.id, 's0003')
    assert.equal(pick?.outlier, true)
    const noWrite = pickFocus(['s0001', 's0002'], cards.slice(0, 2), new Set())
    assert.equal(noWrite?.card.id, 's0002')
    const normal = pickFocus(['s0001'], [cards[0]!], new Set())
    assert.equal(normal?.card.id, 's0001')
  })

  it('S2 evidence cards stay within the shared token cap (Fake=real constant)', () => {
    assert.equal(s2TokenCap(), S2_EVIDENCE_CARD_TOKEN_CAP)
    assert.equal(S2_EVIDENCE_CARD_TOKEN_CAP, 256)
    const openSrc = readFileSync(join(here, '../../src/agent/sessions/open_session.ts'), 'utf8')
    const harnessSrc = readFileSync(join(here, '../../src/agent/sessions/cut_brain_harness.ts'), 'utf8')
    assert.match(openSrc, /S2_EVIDENCE_CARD_TOKEN_CAP/)
    assert.match(harnessSrc, /S2_EVIDENCE_CARD_TOKEN_CAP/)
    const c = card('s0001', { tokens: 8000 })
    const raw = rawFor([c], 'ERR '.repeat(8000))
    for (const kind of EVIDENCE_CARD_KINDS) {
      const ev = materializeEvidenceCard({
        card: c,
        raw,
        kind,
        disclose_index: 1,
        cap: S2_EVIDENCE_CARD_TOKEN_CAP,
      })
      assert.equal(evidenceCardWithinCap(ev), true)
      assert.ok(ev.tokens <= S2_EVIDENCE_CARD_TOKEN_CAP)
      assert.ok(estimateTokens(JSON.stringify(ev.fields)) <= S2_EVIDENCE_CARD_TOKEN_CAP)
    }
  })

  it('parseHoleBTurn forbids focus=2 and same-turn multi-card; accepts evidence then decision', () => {
    const badFocus = parseHoleBTurn({ json: { focus: 2, decision: 'dead_end', confidence: 0.8 }, tool_calls: [] }, 's0001')
    assert.equal(badFocus.ok, false)
    if (!badFocus.ok) assert.equal(badFocus.single_slot_violation, true)

    const multi = parseHoleBTurn(
      {
        json: null,
        tool_calls: [
          { name: 'read_segment', arguments: { segment_id: 's0001', kind: 'structure' } },
          { name: 'read_segment', arguments: { segment_id: 's0001', kind: 'error' } },
        ],
      },
      's0001',
    )
    assert.equal(multi.ok, false)
    if (!multi.ok) assert.equal(multi.evidence_card_violation, true)

    const ev = parseHoleBTurn(
      {
        json: { evidence_request: 'structure', confidence: 0.4, segment_id: 's0001' },
        tool_calls: [],
      },
      's0001',
    )
    assert.equal(ev.ok, true)
    if (ev.ok) assert.equal(ev.action, 'evidence_request')

    const dec = parseHoleBTurn(
      {
        json: null,
        tool_calls: [
          {
            name: 'label_segment',
            arguments: { segment_id: 's0001', label: 'collapse_uncertain', confidence: 0.6 },
          },
        ],
      },
      's0001',
    )
    assert.equal(dec.ok, true)
    if (dec.ok && dec.action === 'decision') {
      assert.equal(dec.label, 'collapse_uncertain')
    }
  })

  it('S1 prompt is single-slot and does not dump unresolved id walls', () => {
    const focusCard = card('s0002', { outcome: 'error' })
    const intent: IntentHypothesis = { text: 'fix', scenario: 'test_fix', version: 0 }
    const text = composeSingleSlotText({
      intent,
      skeleton: { version: 0, nodes: [{ id: 'n', kind: 'turning_point', segment_ids: ['s0002'], note: '' }] },
      skill_id: 'test_fix',
      focus: { card: focusCard, outlier: false, in_skeleton: true },
      decided_n: 3,
      unresolved_n: 12,
      defer_n: 0,
      rounds_left: 4,
      disclose_left: 2,
      rulesHintApplied: true,
    })
    assert.match(text, /focus_slot: 1/)
    assert.match(text, /focus_id: s0002/)
    assert.doesNotMatch(text, /still_unresolved/)
    assert.doesNotMatch(text, /window_segment_ids/)
    assert.match(text, /unresolved_n/)
  })

  it('write outlier uses median × multiplier against the shared floor', () => {
    const cards = [card('a', { tokens: 8 }), card('b', { tokens: 8 }), card('c', { tool: 'Write', writes: ['x'], tokens: 400 })]
    const median = tokenMedian(cards)
    assert.equal(isWriteOutlier(cards[2]!, median), true)
    assert.equal(isWriteOutlier(cards[0]!, median), false)
    assert.equal(overThresholdKeepRate({
      rounds: 4,
      focus_slot: 1,
      single_slot_violations: 0,
      evidence_card_violations: 0,
      illegal_keep_overrides: 1,
      over_threshold_count: 2,
      over_threshold_keep_count: 0,
    }), 0)
  })
})
