import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noul, type Fetch } from '@typesafe-ai/sdk'
import {
  createJevClient,
  FakeJevClient,
  JEV_API_BASE,
  JEV_MODEL_DEFAULT,
  resolveHoleADecision,
} from '../../src/agent/sessions/jev_client.ts'
import { FakeSessionBackend, setSessionBackend } from '../../src/agent/sessions/open_session.ts'
import {
  buildJevQuestions,
  HOLE_A_JEV_FAKE_NOTE,
  HOLE_A_JEV_LIVE_NOTE,
  INTENT_V0_TEMPLATE_NOTE,
  intentTextFromTemplate,
  uncertaintyFromScore,
  JEV_UNCERTAINTY_LEVELS,
} from '../../src/agent/sessions/sparse_intent_jev.ts'
import { sparseIntent } from '../../src/agent/sessions/sparse_intent.ts'
import { skeletonPass } from '../../src/agent/sessions/skeleton_pass.ts'
import {
  JEV_ENOUGH_NOUL_MIN,
  JEV_GAP_ID_CHOICE_MAX,
  JEV_SKELETON_NOUL_MIN,
  SPARSE_INTENT_FORCE_STOP_UNCERTAINTY,
} from '../../src/constant/window.ts'
import type { AgentView } from '../../src/types/agent_view.ts'
import type { RawTrace } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

const TAIL = 'UNIQUE_TAIL_NOT_IN_EXCERPT'

function card(id: string, refs: string[], opts: Partial<SegmentCard> = {}): SegmentCard {
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
  const secret = `${'MIDDLE_SECRET_'.repeat(30)}${TAIL}`
  const raw: RawTrace = {
    meta: {
      trace_id: 't-jev',
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
      { id: 'mid', role: 'assistant', content: secret, tokens: 40 },
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

function baseInput(): {
  trace_id: RawTrace['meta']['trace_id']
  raw: RawTrace
  view: AgentView
  head_turn_ids: string[]
  verification_turn_ids: string[]
  env: NodeJS.Dict<string>
  rng: () => number
} {
  const { raw, view } = fixture()
  return {
    trace_id: raw.meta.trace_id,
    raw,
    view,
    head_turn_ids: ['head-1'],
    verification_turn_ids: ['ver-1'],
    env: {},
    rng: () => 0,
  }
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const found = headers.find((pair) => pair[0].toLowerCase() === name.toLowerCase())
    return found?.[1]
  }
  const rec = headers as Record<string, string>
  const key = Object.keys(rec).find((item) => item.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : rec[key]
}

describe('resolveHoleADecision', () => {
  it('explicit decision beats env, client, and session backend', () => {
    assert.equal(
      resolveHoleADecision({
        decision: 'pi',
        hasJevClient: true,
        hasSessionBackend: true,
        env: { TRACE_DISTILLER_HOLE_A_DECISION: 'jev' },
      }),
      'pi',
    )
    assert.equal(
      resolveHoleADecision({
        decision: 'jev',
        hasSessionBackend: true,
        env: { TRACE_DISTILLER_HOLE_A_DECISION: 'pi' },
      }),
      'jev',
    )
  })

  it('env beats an injected client or session backend', () => {
    assert.equal(
      resolveHoleADecision({
        hasSessionBackend: true,
        env: { TRACE_DISTILLER_HOLE_A_DECISION: 'jev' },
      }),
      'jev',
    )
    assert.equal(
      resolveHoleADecision({
        hasJevClient: true,
        env: { TRACE_DISTILLER_HOLE_A_DECISION: ' pi ' },
      }),
      'pi',
    )
  })

  it('injected client beats session backend; session backend beats the jev default', () => {
    assert.equal(resolveHoleADecision({ hasJevClient: true, hasSessionBackend: true, env: {} }), 'jev')
    assert.equal(resolveHoleADecision({ hasSessionBackend: true, env: {} }), 'pi')
    assert.equal(resolveHoleADecision({ env: {} }), 'jev')
    assert.equal(resolveHoleADecision({ env: { TRACE_DISTILLER_HOLE_A_DECISION: 'nope' } }), 'jev')
  })
})

describe('Jev client', () => {
  it('blank or missing keys use FakeJevClient', () => {
    assert.equal(createJevClient({}).kind, 'fake')
    assert.equal(createJevClient({ TYPESAFE_API_KEY: '   ', TRACE_DISTILLER_JEV_API_KEY: '' }).kind, 'fake')
    assert.ok(createJevClient({}) instanceof FakeJevClient)
  })

  it('alias key and model pin hit systemOne without the real network', async () => {
    const seen: { url: string; auth: string; model: string }[] = []
    const fetchImpl: Fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      seen.push({
        url: String(url),
        auth: header(init, 'authorization') ?? '',
        model: body.model,
      })
      return new Response(
        JSON.stringify({
          model: body.model,
          answers: { enough: { type: 'noul', noul: 0.4 } },
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = createJevClient(
      {
        TRACE_DISTILLER_JEV_API_KEY: 'alias-key',
        TYPESAFE_API_KEY: 'other-key',
        TRACE_DISTILLER_JEV_MODEL: 'jev-1.13.0',
      },
      { fetch: fetchImpl },
    )
    assert.equal(client.kind, 'typesafe')
    const result = await client.systemOne({
      state: { trace_id: 't' },
      questions: { enough: noul('Is the sampled context enough to mark skeleton key points?') },
    })
    assert.equal(seen[0]?.url, `${JEV_API_BASE}/v1/systemone`)
    assert.equal(seen[0]?.auth, 'Bearer alias-key')
    assert.equal(seen[0]?.model, 'jev-1.13.0')
    assert.equal(result.answers.enough?.type, 'noul')
    if (result.answers.enough?.type === 'noul') assert.equal(result.answers.enough.noul, 0.4)
    assert.equal(result.usage.input_tokens, 5)
  })

  it('defaults the model to jev-latest', async () => {
    let model = ''
    const fetchImpl: Fetch = async (_url, init) => {
      model = (JSON.parse(String(init?.body)) as { model: string }).model
      return new Response(
        JSON.stringify({
          model,
          answers: { enough: { type: 'noul', noul: 0.1 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = createJevClient({ TYPESAFE_API_KEY: 'k' }, { fetch: fetchImpl })
    await client.systemOne({ state: 'x', questions: { enough: noul('enough?') } })
    assert.equal(model, JEV_MODEL_DEFAULT)
  })
})

describe('sparse intent Jev', () => {
  it('maps score positions onto 0..1 and builds cut-free questions', () => {
    assert.equal(uncertaintyFromScore(0, JEV_UNCERTAINTY_LEVELS.length), 0)
    assert.equal(uncertaintyFromScore(JEV_UNCERTAINTY_LEVELS.length - 1, JEV_UNCERTAINTY_LEVELS.length), 1)
    assert.equal(uncertaintyFromScore(2, JEV_UNCERTAINTY_LEVELS.length), 0.5)
    assert.equal(intentTextFromTemplate('test_fix', [{ note: 'pytest' }]), 'test_fix: sparse skeleton over 1 key point(s); pytest')
    const questions = buildJevQuestions({ batchIds: ['s0001'], unreadIds: ['s0006'] })
    const blob = JSON.stringify(questions)
    assert.equal(questions.enough?.type, 'noul')
    assert.equal(questions.scenario?.type, 'choice')
    assert.equal(questions.uncertainty?.type, 'score')
    assert.equal(questions.skel_s0001?.type, 'noul')
    assert.equal(questions.kind_s0001?.type, 'choice')
    assert.doesNotMatch(blob, /\b(keep|collapse|drop)\b/)
    assert.equal(JEV_ENOUGH_NOUL_MIN, 0.6)
    assert.equal(JEV_SKELETON_NOUL_MIN, 0.55)
    assert.equal(JEV_GAP_ID_CHOICE_MAX, 8)
  })

  it('completes skeletonPass with FakeJev and no API key', async () => {
    const input = baseInput()
    const out = await skeletonPass({ ...input, decision: 'jev' })
    assert.equal(out.enough, true)
    assert.equal(out.force_stopped, false)
    assert.ok(out.rounds >= 2)
    assert.equal(out.scenario, 'test_fix')
    assert.match(out.intent.text, /^test_fix: sparse skeleton over \d+ key point\(s\)/)
    assert.ok(out.segments_read.includes('s0001'))
    assert.ok(out.segments_read.includes('s0006'))
    assert.ok(out.skeleton.nodes.some((node) => node.segment_ids.includes('s0006')))
    assert.ok(out.skeleton.nodes.every((node) => node.kind === 'turning_point' || node.kind === 'main_path_hypothesis' || node.kind === 'verification_anchor'))
    assert.equal(out.usage.role, 'hole_a_skeleton')
    assert.ok((out.notes ?? []).includes(HOLE_A_JEV_FAKE_NOTE))
    assert.ok((out.notes ?? []).includes(INTENT_V0_TEMPLATE_NOTE))
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'keep'), false)
  })

  it('default without a session backend is FakeJev and masks unread bodies', async () => {
    const input = baseInput()
    const client = new FakeJevClient()
    const out = await sparseIntent({ ...input, jevClient: client })
    assert.equal(out.enough, true)
    assert.ok(out.rounds >= 2)
    assert.equal(client.calls.length, out.rounds)
    const first = JSON.stringify(client.calls[0]?.state)
    const all = JSON.stringify(client.calls.map((call) => call.state))
    assert.doesNotMatch(first, /MIDDLE_SECRET_/)
    assert.doesNotMatch(all, new RegExp(TAIL))
    const second = client.calls[1]?.state
    assert.match(JSON.stringify(second), /s0006/)
    assert.match(JSON.stringify(second), /jev: unread segment/)
    const cards = (second as { cards?: { id: string; excerpt: string | null }[] }).cards ?? []
    const mid = cards.find((c) => c.id === 's0005')
    assert.ok(mid)
    assert.equal(typeof mid?.excerpt, 'string')
    assert.ok((mid?.excerpt ?? '').length <= 120)
    assert.doesNotMatch(mid?.excerpt ?? '', new RegExp(TAIL))
    const asked = Object.keys(client.calls[0]?.questions ?? {})
    assert.ok(asked.includes('skel_s0001'))
    assert.equal(asked.includes('skel_s0006'), false)
  })

  it('hard round budget force-stops with high uncertainty and no cut fields', async () => {
    const input = baseInput()
    const out = await sparseIntent({ ...input, decision: 'jev', max_rounds: 1 })
    assert.equal(out.rounds, 1)
    assert.equal(out.enough, false)
    assert.equal(out.force_stopped, true)
    assert.ok(out.uncertainty >= SPARSE_INTENT_FORCE_STOP_UNCERTAINTY)
    assert.ok(out.segments_read.length > 0)
    assert.ok(out.skeleton.nodes.length > 0)
    assert.match(out.intent.text, /sparse skeleton/)
    assert.ok((out.notes ?? []).some((note) => note.includes('max_rounds')))
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'collapse'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'drop'), false)
  })

  it('empty pool force-stops without calling Jev', async () => {
    const input = baseInput()
    input.view = { ...input.view, segments: [] }
    const client = new FakeJevClient()
    const out = await sparseIntent({ ...input, jevClient: client })
    assert.equal(client.calls.length, 0)
    assert.equal(out.rounds, 0)
    assert.equal(out.enough, false)
    assert.equal(out.force_stopped, true)
    assert.ok(out.uncertainty >= SPARSE_INTENT_FORCE_STOP_UNCERTAINTY)
    assert.match(out.intent.text, /^implement: sparse skeleton/)
    assert.ok((out.notes ?? []).includes('sparse_intent_empty_pool'))
  })

  it('explicit jev ignores an injected pi backend', async () => {
    const input = baseInput()
    const fake = new FakeSessionBackend(() => {
      throw new Error('pi hole A should not run')
    })
    const out = await sparseIntent({ ...input, backend: fake, decision: 'jev' })
    assert.equal(fake.calls.length, 0)
    assert.equal(out.enough, true)
    assert.equal(out.scenario, 'test_fix')
  })

  it('env jev overrides an injected session backend', async () => {
    const input = baseInput()
    const fake = new FakeSessionBackend(() => {
      throw new Error('pi hole A should not run')
    })
    const out = await sparseIntent({
      ...input,
      backend: fake,
      env: { TRACE_DISTILLER_HOLE_A_DECISION: 'jev' },
    })
    assert.equal(fake.calls.length, 0)
    assert.ok((out.notes ?? []).includes(HOLE_A_JEV_FAKE_NOTE))
  })

  it('a globally injected session backend keeps the pi Hole A path', async () => {
    const input = baseInput()
    const fake = new FakeSessionBackend(() => ({
      text: JSON.stringify({
        kind: 'sparse_intent_v0',
        enough: true,
        intent_v0: 'from pi',
        scenario: 'implement',
        skeleton_points: [],
        uncertainty: 0.2,
      }),
      json: {
        kind: 'sparse_intent_v0',
        enough: true,
        intent_v0: 'from pi',
        scenario: 'implement',
        skeleton_points: [],
        uncertainty: 0.2,
      },
      tool_calls: [],
      usage: { role: 'hole_a_skeleton', input_tokens: 3, output_tokens: 1 },
    }))
    setSessionBackend(fake)
    try {
      const out = await sparseIntent(input)
      assert.equal(out.intent.text, 'from pi')
      assert.ok(fake.calls.length > 0)
      assert.equal((out.notes ?? []).includes(HOLE_A_JEV_FAKE_NOTE), false)
    } finally {
      setSessionBackend(undefined)
    }
  })

  it('aborts before a Jev call', async () => {
    const input = baseInput()
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => sparseIntent({ ...input, decision: 'jev', signal: ac.signal }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    )
  })

  it('live client adapter feeds the loop from a stubbed systemOne response', async () => {
    const input = baseInput()
    const seen: string[] = []
    const fetchImpl: Fetch = async (url, init) => {
      seen.push(String(url))
      const body = JSON.parse(String(init?.body)) as {
        model: string
        questions: Record<string, { type: string; criteria?: Record<string, unknown> }>
      }
      const answers: Record<string, unknown> = {}
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === 'noul') {
          answers[name] = { type: 'noul', noul: name === 'enough' ? 0.95 : 0.91 }
        } else if (question.type === 'score') {
          answers[name] = { type: 'score', score: 1, confidence: 0.8 }
        } else {
          const keys = question.criteria !== undefined ? Object.keys(question.criteria) : []
          const choice = name === 'scenario' && keys.includes('implement') ? 'implement' : (keys[0] ?? 'none')
          answers[name] = { type: 'choice', choice, confidence: 0.8, probabilities: {} }
        }
      }
      return new Response(
        JSON.stringify({
          model: body.model,
          answers,
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = createJevClient(
      { TYPESAFE_API_KEY: 'test-key', TRACE_DISTILLER_JEV_MODEL: 'jev-1.13.0' },
      { fetch: fetchImpl },
    )
    const out = await skeletonPass({ ...input, decision: 'jev', jevClient: client })
    assert.equal(seen[0], `${JEV_API_BASE}/v1/systemone`)
    assert.equal(out.enough, true)
    assert.equal(out.rounds, 1)
    assert.equal(out.scenario, 'implement')
    assert.equal(out.usage.input_tokens, 12)
    assert.equal(out.usage.output_tokens, 3)
    assert.ok((out.notes ?? []).includes(HOLE_A_JEV_LIVE_NOTE))
    assert.ok(out.skeleton.nodes.length > 0)
    assert.doesNotMatch(JSON.stringify(out), new RegExp(TAIL))
  })
})
