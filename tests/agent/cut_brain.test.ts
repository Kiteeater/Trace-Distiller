import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { CUT_BRAIN_TOOL_NAMES, HOLE_TOOL_NAMES } from '../../src/agent/extension.ts'
import { cutBrain } from '../../src/agent/sessions/cut_brain.ts'
import {
  FakeSessionBackend,
  readMarkedJson,
  type ResolvedSessionOpts,
  type SessionPromptInput,
  type SessionPromptResult,
} from '../../src/agent/sessions/open_session.ts'
import {
  CUT_BRAIN_FOCUS_SLOT,
  CUT_BRAIN_LOW_CONFIDENCE,
  S2_EVIDENCE_CARD_TOKEN_CAP,
} from '../../src/constant/window.ts'
import { COLLAPSE_UNCERTAIN_RULE, DROP_BY_POLICY_RULE } from '../../src/domain/cut_decision.ts'
import { applyRules } from '../../src/pipeline/rules.ts'
import { segment } from '../../src/pipeline/segmenter.ts'
import type { IntentHypothesis, Skeleton } from '../../src/types/agent_view.ts'
import type { AgentView } from '../../src/types/agent_view.ts'
import type { RawTrace, RawTurn } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')
const skillPath = 'src/agent/skills/test_fix.md'

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

function fakeResult(
  opts: {
    tool_calls?: SessionPromptResult['tool_calls']
    json?: unknown
    role?: SessionPromptResult['usage']['role']
  } = {},
): SessionPromptResult {
  return {
    text: '',
    json: opts.json ?? null,
    tool_calls: opts.tool_calls ?? [],
    usage: { role: opts.role ?? 'hole_b_label', input_tokens: 6, output_tokens: 3 },
  }
}

function parseFocusId(text: string): string | undefined {
  const marked = readMarkedJson(text, 'FOCUS_CARD')
  if (typeof marked === 'object' && marked !== null && !Array.isArray(marked)) {
    const id = (marked as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  const match = text.match(/focus_id:\s*"?([A-Za-z0-9_-]+)"?/)
  return match?.[1]
}

function intent(): IntentHypothesis {
  return { text: 'fix add', scenario: 'test_fix', version: 0 }
}

describe('cutBrain', () => {
  it('opens hole_b_label with the full cut-brain tool allowlist', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const backend = new FakeSessionBackend()
    await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.ok(backend.calls.length > 0)
    assert.equal(backend.calls[0]!.role, 'hole_b_label')
    assert.deepEqual([...backend.calls[0]!.tools].sort(), [...CUT_BRAIN_TOOL_NAMES].sort())
    assert.deepEqual([...HOLE_TOOL_NAMES].sort(), [...CUT_BRAIN_TOOL_NAMES].sort())
  })

  it('single-slot prompts: focus=1, S0 pointers only, no still_unresolved dump', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const backend = new FakeSessionBackend()
    const out = await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.equal(out.metrics.focus_slot, CUT_BRAIN_FOCUS_SLOT)
    const holeB = backend.calls.filter((c) => c.role === 'hole_b_label')
    assert.ok(holeB.length > 0)
    for (const call of holeB) {
      assert.match(call.input.text, /focus_slot: 1/)
      assert.match(call.input.text, /focus_id:/)
      assert.match(call.input.text, /---S0_POINTERS---/)
      assert.match(call.input.text, /---FOCUS_CARD---/)
      assert.match(call.input.text, /---S3---/)
      assert.doesNotMatch(call.input.text, /window_segment_ids/)
      assert.doesNotMatch(call.input.text, /WINDOW_CARDS/)
      assert.doesNotMatch(call.input.text, /still_unresolved:/)
      const s0 = readMarkedJson(call.input.text, 'S0_POINTERS')
      assert.equal(typeof s0, 'object')
      const rec = s0 as Record<string, unknown>
      assert.equal(typeof rec.unresolved_n, 'number')
      assert.equal(Array.isArray(rec.unresolved_ids), false)
      const focus = readMarkedJson(call.input.text, 'FOCUS_CARD') as { focus_slot?: unknown }
      assert.equal(focus.focus_slot, 1)
    }
    const composed = holeB.map((c) => c.composed).join('\n')
    assert.doesNotMatch(composed, /still_unresolved:\s*\[/)
  })

  it('adopts applyRules only after apply_rules_hint; remaining are not useful_exploration keep', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const ruled = applyRules({ view, raw })
    const backend = new FakeSessionBackend()
    const out = await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })

    assert.equal(out.rules_hint_applied, true)
    const ruleIds = new Set(ruled.decisions.map((d) => d.segment_id))
    for (const d of out.decisions) {
      if (ruleIds.has(d.segment_id)) {
        assert.equal(d.source.kind, 'rule')
      } else {
        assert.notEqual(d.label, 'useful_exploration')
        assert.ok(d.label === 'collapse_uncertain' || d.label === 'key_decision' || d.label === 'dead_end' || d.label === 'routine')
      }
    }
    assert.deepEqual(out.still_unresolved, [])
    assert.ok(backend.calls.some((c) => c.input.text.includes('apply_rules_hint')))
    const composed = backend.calls.map((c) => c.composed).join('\n')
    assert.match(composed, /apply_rules_hint/)
    assert.match(composed, /ACK /)
    assert.doesNotMatch(composed, /MASKED_TOOL_RESULTS/)
  })

  it('keep_segment with keep_bits commits; without bits harness overrides to collapse_uncertain', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const ids = view.segments.map((s) => s.id)
    const backend = new FakeSessionBackend((input: SessionPromptInput, opts: ResolvedSessionOpts) => {
      void opts
      const target = parseFocusId(input.text) ?? ids[0]!
      return fakeResult({
        tool_calls: [
          {
            name: 'keep_segment',
            arguments: { segment_id: target, confidence: 0.9, keep_bits: ['key_decision_flag'] },
          },
        ],
      })
    })
    const out = await cutBrain({
      segment_ids: ids,
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
      max_rounds: 2,
    })
    assert.equal(out.rules_hint_applied, false)
    assert.ok(out.decisions.length >= 1)
    assert.equal(out.decisions[0]!.source.name, 'keep_segment')
    assert.equal(out.decisions[0]!.label, 'key_decision')
    assert.ok(out.still_unresolved.length > 0)
    assert.equal(out.still_unresolved.includes(out.decisions[0]!.segment_id), false)

    const illegal = new FakeSessionBackend((input: SessionPromptInput) => {
      const target = parseFocusId(input.text) ?? ids[0]!
      return fakeResult({
        tool_calls: [{ name: 'keep_segment', arguments: { segment_id: target, confidence: 0.9 } }],
      })
    })
    const rejected = await cutBrain({
      segment_ids: ids.slice(0, 1),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend: illegal,
    })
    assert.equal(rejected.decisions.length, 1)
    assert.equal(rejected.decisions[0]!.label, 'collapse_uncertain')
    assert.equal(rejected.decisions[0]!.source.name, COLLAPSE_UNCERTAIN_RULE)
    assert.ok(rejected.metrics.illegal_keep_overrides >= 1)
  })

  it('does not adopt rules when the agent never calls apply_rules_hint', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const ids = view.segments.map((s) => s.id)
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const focusId = parseFocusId(input.text)
      if (focusId === undefined) return fakeResult({ tool_calls: [] })
      return fakeResult({
        tool_calls: [{ name: 'label_segment', arguments: { segment_id: focusId, label: 'dead_end', confidence: 0.8 } }],
      })
    })
    const out = await cutBrain({
      segment_ids: ids,
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
      max_rounds: 1,
    })
    assert.equal(out.rules_hint_applied, false)
    assert.ok(out.decisions.length >= 1)
    assert.equal(out.decisions.every((d) => d.source.kind === 'llm'), true)
    assert.equal(out.decisions.every((d) => d.label === 'dead_end'), true)
  })

  it('Fake default never trains useful_exploration→keep', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const backend = new FakeSessionBackend()
    const out = await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    for (const d of out.decisions) {
      if (d.source.kind === 'llm') {
        assert.notEqual(d.label, 'useful_exploration')
      }
    }
    const keepLabels = out.decisions.filter((d) => d.label === 'key_decision' || d.label === 'useful_exploration')
    for (const d of keepLabels) {
      assert.ok(d.confidence >= CUT_BRAIN_LOW_CONFIDENCE)
    }
  })
})

function synthCard(id: string, extra: Partial<SegmentCard> = {}): SegmentCard {
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
    raw_refs: extra.raw_refs ?? [id.replace('s', 't')],
  }
}

function synthWorld(cards: SegmentCard[], skeleton: Skeleton = { version: 0, nodes: [] }): {
  raw: RawTrace
  view: AgentView
} {
  const turns: RawTurn[] = cards.map((c) => ({
    id: c.raw_refs[0] ?? c.id,
    role: 'tool_call' as const,
    content: `body-${c.id}-${'x'.repeat(Math.max(0, c.tokens * 2))}`,
    tokens: c.tokens,
  }))
  const raw: RawTrace = {
    meta: {
      trace_id: 'cut-brain-synth',
      source: 'claude-code',
      ground_truth_ref: 'g',
      total_tokens: turns.reduce((s, t) => s + t.tokens, 0),
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
    turns,
    anchor_turn_ids: [],
  }
  const view: AgentView = {
    meta: raw.meta,
    intent_hypothesis: intent(),
    skeleton,
    segments: cards,
  }
  return { raw, view }
}

describe('cutBrain ADR-0012 decision table', () => {
  it('hard fail with no B output leaves still_unresolved (0010 Keep at orchestrator)', async () => {
    const { raw, view } = synthWorld([synthCard('s0001'), synthCard('s0002')])
    const backend = new FakeSessionBackend(() => {
      throw new Error('transport boom')
    })
    const out = await cutBrain({
      segment_ids: ['s0001', 's0002'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.deepEqual(out.still_unresolved, ['s0001', 's0002'])
    assert.equal(out.decisions.length, 0)
    assert.ok(out.notes?.some((n) => n.includes('transport boom')))
  })

  it('schema-illegal retries exhausted → collapse_uncertain, not 0010 Keep', async () => {
    const { raw, view } = synthWorld([synthCard('s0001')])
    const backend = new FakeSessionBackend(() => fakeResult({ tool_calls: [] }))
    const out = await cutBrain({
      segment_ids: ['s0001'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.deepEqual(out.still_unresolved, [])
    assert.equal(out.decisions.length, 1)
    assert.equal(out.decisions[0]!.label, 'collapse_uncertain')
    assert.equal(out.decisions[0]!.source.name, COLLAPSE_UNCERTAIN_RULE)
  })

  it('disclose cap still low-confidence → collapse_uncertain (not keep)', async () => {
    const cards = [
      synthCard('s0001', { outcome: 'error', tokens: 40 }),
      synthCard('s0002'),
      synthCard('s0003'),
    ]
    const { raw, view } = synthWorld(cards)
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const id = parseFocusId(input.text) ?? 's0001'
      return fakeResult({
        json: {
          kind: 'hole_b_turn_v1',
          segment_id: id,
          decision: null,
          confidence: 0.2,
          evidence_request: 'error',
        },
        tool_calls: [{ name: 'read_segment', arguments: { segment_id: id, kind: 'error' } }],
      })
    })
    const out = await cutBrain({
      segment_ids: cards.map((c) => c.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    const first = out.decisions.find((d) => d.segment_id === 's0001')
    assert.equal(first?.label, 'collapse_uncertain')
    assert.notEqual(first?.label, 'key_decision')
    assert.notEqual(first?.label, 'useful_exploration')
    const acks = backend.calls.map((c) => c.input.messages?.map((m) => m.content).join('\n') ?? '')
    assert.ok(acks.some((a) => a.includes('ACK card_id=s2:')))
    const withS2 = backend.calls.filter((c) => c.input.text.includes('EVIDENCE_CARD'))
    assert.ok(withS2.length >= 1)
    for (const call of withS2) {
      const card = readMarkedJson(call.input.text, 'EVIDENCE_CARD') as { tokens?: number }
      assert.ok(typeof card.tokens === 'number')
      assert.ok(card.tokens <= S2_EVIDENCE_CARD_TOKEN_CAP)
    }
  })

  it('budget exhaust remaining → collapse_uncertain; drop_by_policy only for routine predicates', async () => {
    const cards = [
      synthCard('s0001', { tool: 'Write', writes: ['a.ts'], tokens: 80 }),
      synthCard('s0002', { tool: 'Write', writes: ['b.ts'], tokens: 80 }),
      synthCard('s0003', { tool: 'Write', writes: ['c.ts'], tokens: 80 }),
    ]
    const { raw, view } = synthWorld(cards)
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const id = parseFocusId(input.text) ?? 's0001'
      return fakeResult({
        tool_calls: [{ name: 'read_segment', arguments: { segment_id: id, kind: 'structure' } }],
      })
    })
    const out = await cutBrain({
      segment_ids: cards.map((c) => c.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.deepEqual(out.still_unresolved, [])
    assert.ok(out.decisions.every((d) => d.label === 'collapse_uncertain' || d.label === 'routine'))
    assert.ok(out.decisions.some((d) => d.label === 'collapse_uncertain'))
    for (const d of out.decisions) {
      if (d.label === 'routine') {
        assert.equal(d.source.name, DROP_BY_POLICY_RULE)
      }
    }
    assert.ok(out.notes?.some((n) => n.startsWith('cut_brain_budget_exhaust:') || n.includes('schema')))
  })

  it('illegal keep (missing bits) → harness collapse_uncertain; legal collapse accepted', async () => {
    const cards = [synthCard('s0001'), synthCard('s0002')]
    const { raw, view } = synthWorld(cards)
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const id = parseFocusId(input.text)
      if (id === 's0001') {
        return fakeResult({
          tool_calls: [
            {
              name: 'label_segment',
              arguments: { segment_id: id, label: 'useful_exploration', confidence: 0.9 },
            },
          ],
        })
      }
      return fakeResult({
        tool_calls: [
          { name: 'label_segment', arguments: { segment_id: id, label: 'dead_end', confidence: 0.8 } },
        ],
      })
    })
    const out = await cutBrain({
      segment_ids: ['s0001', 's0002'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    const d1 = out.decisions.find((d) => d.segment_id === 's0001')
    const d2 = out.decisions.find((d) => d.segment_id === 's0002')
    assert.equal(d1?.label, 'collapse_uncertain')
    assert.equal(d1?.source.name, COLLAPSE_UNCERTAIN_RULE)
    assert.equal(d2?.label, 'dead_end')
    assert.equal(d2?.source.kind, 'llm')
    assert.ok(out.metrics.illegal_keep_overrides >= 1)
  })

  it('low-confidence keep never lands on keep', async () => {
    const { raw, view } = synthWorld([synthCard('s0001')], {
      version: 0,
      nodes: [{ id: 'n1', kind: 'turning_point', segment_ids: ['s0001'], note: '' }],
    })
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const id = parseFocusId(input.text) ?? 's0001'
      return fakeResult({
        tool_calls: [
          {
            name: 'label_segment',
            arguments: {
              segment_id: id,
              label: 'key_decision',
              confidence: 0.49,
              keep_bits: ['skeleton_hit'],
            },
          },
        ],
      })
    })
    const out = await cutBrain({
      segment_ids: ['s0001'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.equal(out.decisions[0]!.label, 'collapse_uncertain')
    assert.notEqual(out.decisions[0]!.label, 'key_decision')
    assert.notEqual(out.decisions[0]!.label, 'useful_exploration')
  })

  it('legal keep with skeleton_hit is accepted; Fake over-threshold Write is not keep', async () => {
    const cards = [
      synthCard('s0001', { tool: 'Write', writes: ['big.ts'], tokens: 400 }),
      synthCard('s0002', { tool: 'Edit', writes: ['ok.ts'], tokens: 12 }),
      synthCard('s0003', { tokens: 8 }),
    ]
    const skeleton: Skeleton = {
      version: 0,
      nodes: [{ id: 'n1', kind: 'turning_point', segment_ids: ['s0002'], note: 'edit' }],
    }
    const { raw, view } = synthWorld(cards, skeleton)
    const fake = new FakeSessionBackend()
    const out = await cutBrain({
      segment_ids: ['s0001', 's0002', 's0003'],
      view,
      raw,
      skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend: fake,
    })
    const write = out.decisions.find((d) => d.segment_id === 's0001')
    const edit = out.decisions.find((d) => d.segment_id === 's0002')
    assert.ok(write)
    assert.notEqual(write!.label, 'useful_exploration')
    assert.notEqual(write!.label, 'key_decision')
    assert.equal(edit?.label, 'key_decision')
    assert.ok((edit?.confidence ?? 0) >= CUT_BRAIN_LOW_CONFIDENCE)
  })

  it('Fake does not encode 2 discloses → keep', async () => {
    const { raw, view } = synthWorld([synthCard('s0001', { outcome: 'error', tokens: 30 })])
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const id = parseFocusId(input.text) ?? 's0001'
      if (!input.text.includes('EVIDENCE_CARD')) {
        return fakeResult({
          json: {
            kind: 'hole_b_turn_v1',
            segment_id: id,
            decision: null,
            confidence: 0.4,
            evidence_request: 'error',
            s2_token_cap: S2_EVIDENCE_CARD_TOKEN_CAP,
          },
          tool_calls: [{ name: 'read_segment', arguments: { segment_id: id, kind: 'error' } }],
        })
      }
      return fakeResult({
        tool_calls: [
          {
            name: 'label_segment',
            arguments: { segment_id: id, label: 'key_decision', confidence: 0.9 },
          },
        ],
      })
    })
    const out = await cutBrain({
      segment_ids: ['s0001'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.equal(out.decisions[0]!.label, 'collapse_uncertain')
    assert.notEqual(out.decisions[0]!.label, 'key_decision')
    assert.notEqual(out.decisions[0]!.label, 'useful_exploration')
    const evidencePrompts = backend.calls.filter((c) => c.input.text.includes('EVIDENCE_CARD'))
    assert.ok(evidencePrompts.length >= 1)
    assert.ok(evidencePrompts.length <= 2)
  })

  it('same-turn multi-id is a single-slot violation and does not keep', async () => {
    const { raw, view } = synthWorld([synthCard('s0001'), synthCard('s0002')])
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      void input
      return fakeResult({
        json: { focus: 2 },
        tool_calls: [
          { name: 'label_segment', arguments: { segment_id: 's0001', label: 'key_decision', confidence: 0.9, keep_bits: ['key_decision_flag'] } },
          { name: 'label_segment', arguments: { segment_id: 's0002', label: 'key_decision', confidence: 0.9, keep_bits: ['key_decision_flag'] } },
        ],
      })
    })
    const out = await cutBrain({
      segment_ids: ['s0001', 's0002'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend,
    })
    assert.ok(out.metrics.single_slot_violations >= 1)
    for (const d of out.decisions) {
      assert.notEqual(d.label, 'useful_exploration')
    }
  })
})
