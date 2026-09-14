import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AGENT_ROLES } from '../../src/enums/agent_role.ts'
import { cutBrain } from '../../src/agent/sessions/cut_brain.ts'
import { interpretQaResult } from '../../src/agent/sessions/l4_qa.ts'
import { interpretReplayResult } from '../../src/agent/sessions/l4_replay.ts'
import { interpretReviewResult } from '../../src/agent/sessions/l4_review.ts'
import { checkContinuityPair, labelWindow } from '../../src/agent/sessions/label_window.ts'
import {
  FakeSessionBackend,
  SESSION_DISPOSED_MESSAGE,
  SESSION_RUNNER_LIFECYCLE,
  assertTokenUsageHasRole,
  isDistillSpendRole,
  isL4Role,
  isSessionDisposed,
  openSession,
  type PiSessionHandle,
  type ResolvedSessionOpts,
  type SessionBackend,
  type SessionPromptInput,
  type SessionPromptResult,
} from '../../src/agent/sessions/open_session.ts'
import { sparseIntent } from '../../src/agent/sessions/sparse_intent.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../../src/types/agent_view.ts'
import type { RawTrace, RawTurn } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

const skillPath = 'src/agent/skills/test_fix.md'

function recordingBackend(inner: FakeSessionBackend): {
  backend: SessionBackend
  handles: PiSessionHandle[]
} {
  const handles: PiSessionHandle[] = []
  return {
    handles,
    backend: {
      open(opts: ResolvedSessionOpts): PiSessionHandle {
        const handle = inner.open(opts)
        handles.push(handle)
        return handle
      },
    },
  }
}

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
    raw_refs: extra.raw_refs ?? [id.replace('s', 't')],
  }
}

function intent(): IntentHypothesis {
  return { text: 'fix add', scenario: 'test_fix', version: 0 }
}

function world(cards: SegmentCard[], skeleton: Skeleton = { version: 0, nodes: [] }): {
  raw: RawTrace
  view: AgentView
} {
  const turns: RawTurn[] = cards.map((c) => ({
    id: c.raw_refs[0] ?? c.id,
    role: 'tool_call' as const,
    content: `body-${c.id}`,
    tokens: c.tokens,
  }))
  const raw: RawTrace = {
    meta: {
      trace_id: 'lifecycle-synth',
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

function promptResult(
  role: SessionPromptResult['usage']['role'],
  extra: Partial<SessionPromptResult> = {},
): SessionPromptResult {
  return {
    text: extra.text ?? '',
    json: extra.json ?? null,
    tool_calls: extra.tool_calls ?? [],
    usage: extra.usage ?? { role, input_tokens: 4, output_tokens: 2 },
  }
}

describe('session runner lifecycle', () => {
  it('SESSION_RUNNER_LIFECYCLE equals open → (attach?) → prompt* → abort?/dispose', () => {
    assert.deepEqual([...SESSION_RUNNER_LIFECYCLE], ['open', 'attach?', 'prompt*', 'abort?/dispose'])
  })

  it('dispose on abort: Fake handle.disposed and subsequent prompt rejects', async () => {
    const fake = new FakeSessionBackend()
    const handle = openSession({ role: 'l4_qa', backend: fake })
    assert.equal(isSessionDisposed(handle), false)
    await handle.abort()
    assert.equal(handle.disposed, true)
    assert.equal(isSessionDisposed(handle), true)
    await assert.rejects(() => handle.prompt({ text: 'after abort' }), new RegExp(SESSION_DISPOSED_MESSAGE))
  })

  it('dispose on budget exhaust (Hole A sparseIntent)', async () => {
    const { raw, view } = world([card('s0001'), card('s0002')])
    const recorded = recordingBackend(
      new FakeSessionBackend(() =>
        promptResult('hole_a_skeleton', {
          text: JSON.stringify({
            kind: 'sparse_intent_v0',
            enough: false,
            intent_v0: 'still unsure',
            scenario: 'implement',
            skeleton_points: [],
            uncertainty: 0.8,
          }),
          json: {
            kind: 'sparse_intent_v0',
            enough: false,
            intent_v0: 'still unsure',
            scenario: 'implement',
            skeleton_points: [],
            uncertainty: 0.8,
          },
          usage: { role: 'hole_a_skeleton', input_tokens: 50, output_tokens: 10 },
        }),
      ),
    )
    const out = await sparseIntent({
      trace_id: raw.meta.trace_id,
      raw,
      view,
      backend: recorded.backend,
      max_rounds: 1,
      max_tokens: 1,
    })
    assert.equal(out.force_stopped, true)
    assert.ok((out.notes ?? []).some((n) => n.includes('budget') || n.includes('max_rounds')))
    assert.ok(recorded.handles.length >= 1)
    for (const handle of recorded.handles) {
      assert.equal(isSessionDisposed(handle), true)
      assert.equal(handle.disposed, true)
    }
    assert.equal(out.usage.role, 'hole_a_skeleton')
    assertTokenUsageHasRole(out.usage)
  })

  it('dispose on budget exhaust (Hole B cutBrain)', async () => {
    const skeleton: Skeleton = {
      version: 0,
      nodes: [{ id: 'n1', kind: 'turning_point', segment_ids: ['s0001'], note: '' }],
    }
    const { raw, view } = world([card('s0001')], skeleton)
    const recorded = recordingBackend(
      new FakeSessionBackend((input: SessionPromptInput) => {
        const match = input.text.match(/"id"\s*:\s*"([^"]+)"/)
        const id = match?.[1] ?? 's0001'
        return promptResult('hole_b_label', {
          tool_calls: [{ name: 'read_segment', arguments: { segment_id: id, kind: 'structure' } }],
        })
      }),
    )
    const out = await cutBrain({
      segment_ids: ['s0001'],
      view,
      raw,
      skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend: recorded.backend,
    })
    assert.ok(out.notes?.some((n) => n.startsWith('cut_brain_budget_exhaust:')))
    assert.ok(recorded.handles.length >= 1)
    for (const handle of recorded.handles) {
      assert.equal(isSessionDisposed(handle), true)
      assert.equal(handle.disposed, true)
    }
    assert.equal(out.usage.role, 'hole_b_label')
    assertTokenUsageHasRole(out.usage)
  })

  it('usage carries AgentRole; distill spend is A+B only', async () => {
    const fake = new FakeSessionBackend()
    const handle = openSession({ role: 'hole_a_skeleton', backend: fake })
    const prompted = await handle.prompt({ text: 'intent' })
    assert.equal(prompted.usage.role, 'hole_a_skeleton')
    assertTokenUsageHasRole(prompted.usage)
    handle.dispose()

    const { raw, view } = world([card('s0001'), card('s0002')])
    const sparse = await sparseIntent({
      trace_id: raw.meta.trace_id,
      raw,
      view,
      backend: new FakeSessionBackend(),
      max_rounds: 1,
    })
    assert.ok((AGENT_ROLES as readonly string[]).includes(sparse.usage.role))
    assert.equal(sparse.usage.role, 'hole_a_skeleton')

    const cut = await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend: new FakeSessionBackend(),
      max_rounds: 1,
    })
    assert.equal(cut.usage.role, 'hole_b_label')

    const labeled = await labelWindow({
      segment_ids: [view.segments[0]!.id],
      view,
      raw,
      skeleton: view.skeleton,
      intent: intent(),
      skill_path: skillPath,
      backend: new FakeSessionBackend(),
    })
    assert.equal(labeled.usage.role, 'hole_b_label')

    const pair = await checkContinuityPair(
      view.segments[0]!,
      view.segments[1]!,
      view.skeleton,
      new FakeSessionBackend(),
    )
    assert.equal(pair.usage.role, 'hole_b_label')

    const qa = interpretQaResult(
      {
        text: JSON.stringify({
          kind: 'l4_qa_v0',
          items: [{ id: 'q1', question: 'q', answer: 'a', correct: true }],
        }),
        json: {
          kind: 'l4_qa_v0',
          items: [{ id: 'q1', question: 'q', answer: 'a', correct: true }],
        },
        tool_calls: [],
        usage: { role: 'l4_qa', input_tokens: 3, output_tokens: 1 },
      },
      'l4_qa',
    )
    assert.equal(qa.usage.role, 'l4_qa')

    const replay = interpretReplayResult(
      {
        text: JSON.stringify({ kind: 'l4_replay_v0', success: true }),
        json: { kind: 'l4_replay_v0', success: true },
        tool_calls: [],
        usage: { role: 'l4_replay', input_tokens: 3, output_tokens: 1 },
      },
      'l4_replay',
    )
    assert.equal(replay.usage.role, 'l4_replay')

    const review = interpretReviewResult(
      {
        text: JSON.stringify({
          kind: 'l4_review_v0',
          turning_point_segment_ids: ['s0001'],
          evidence_segment_ids: [],
        }),
        json: {
          kind: 'l4_review_v0',
          turning_point_segment_ids: ['s0001'],
          evidence_segment_ids: [],
        },
        tool_calls: [],
        usage: { role: 'l4_review', input_tokens: 3, output_tokens: 1 },
      },
      'l4_review',
    )
    assert.equal(review.usage.role, 'l4_review')

    assert.equal(isDistillSpendRole('hole_a_skeleton'), true)
    assert.equal(isDistillSpendRole('hole_b_label'), true)
    assert.equal(isL4Role('l4_qa'), true)
    assert.equal(isDistillSpendRole('l4_qa'), false)
    assert.equal(isL4Role('hole_a_skeleton'), false)
  })

  it('assertTokenUsageHasRole throws on missing or garbage role', () => {
    assert.throws(() => assertTokenUsageHasRole({}), /AgentRole/)
    assert.throws(() => assertTokenUsageHasRole({ role: 'orchestrator' }), /AgentRole/)
    assert.doesNotThrow(() => assertTokenUsageHasRole({ role: 'hole_b_label' }))
  })
})
