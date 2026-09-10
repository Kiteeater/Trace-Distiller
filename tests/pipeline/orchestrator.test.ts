import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { SKELETON_PASS_JSON_KIND } from '../../src/agent/sessions/skeleton_pass.ts'
import {
  FakeSessionBackend,
  setSessionBackend,
  type SessionPromptInput,
  type SessionPromptResult,
  type ResolvedSessionOpts,
} from '../../src/agent/sessions/open_session.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { LABEL_WINDOW_SIZE, REVIEW_MAX_ROUNDS } from '../../src/constant/window.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../../src/domain/cut_decision.ts'
import {
  distill,
  fillInKeepWarrant,
  resolveDistillMode,
  runBlindReviewFillIn,
} from '../../src/pipeline/orchestrator.ts'
import { applyRules } from '../../src/pipeline/rules.ts'
import { segment } from '../../src/pipeline/segmenter.ts'
import { writeWarrant } from '../../src/agent/sessions/write_warrant.ts'
import type { Skeleton } from '../../src/types/agent_view.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')
const pipelineSrc = join(here, '../../src/pipeline/orchestrator.ts')

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

describe('orchestrator no_llm', () => {
  afterEach(() => {
    setSessionBackend(undefined)
  })

  it('does not import pi or createAgentSession; warrant comes from write_warrant', () => {
    const src = readFileSync(pipelineSrc, 'utf8')
    assert.doesNotMatch(src, /@mariozechner\/pi/)
    assert.doesNotMatch(src, /createAgentSession/)
    assert.doesNotMatch(src, /from ['"]pi['"]/)
    assert.match(src, /agent\/sessions\/write_warrant/)
    assert.match(src, /skeleton_pass/)
    assert.match(src, /label_window/)
    assert.doesNotMatch(src, /l4_qa/)
    assert.doesNotMatch(src, /l4_replay/)
    assert.doesNotMatch(src, /l4_review/)
    assert.doesNotMatch(src, /\brunQa\b/)
    assert.doesNotMatch(src, /\brunReplay\b/)
    assert.doesNotMatch(src, /\brunBlindReview\(/)
    assert.doesNotMatch(src, /TRACE_DISTILLER_MODEL_L4/)
  })

  it('runs adapter fixture to plan + training/playback; resolved drop/collapse, unresolved keep', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const out = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })

    assert.equal(out.plan.trace_id, raw.meta.trace_id)
    assert.equal(out.plan.profile_id, DEFAULT_CUT_PROFILE.id)
    assert.equal(out.training.trace_id, out.plan.trace_id)
    assert.equal(out.playback.trace_id, out.plan.trace_id)
    assert.equal(out.training.plan_ref, out.playback.plan_ref)
    assert.ok(out.training.turns.length > 0)
    assert.ok(out.playback.cards.length > 0)
    assert.equal(out.metrics_ref, '')

    const warrantIds = out.warrant.entries.map((e) => e.segment_id)
    assert.deepEqual(
      warrantIds,
      ruled.view.segments.map((s) => s.id),
    )

    assert.ok(ruled.decisions.some((d) => d.label === 'routine'))
    assert.ok(ruled.decisions.some((d) => d.label === 'dead_end'))
    assert.ok(ruled.unresolved_ids.length > 0)

    for (const d of ruled.decisions) {
      if (d.label === 'routine') {
        assert.equal(out.plan.dropped.includes(d.segment_id), true, d.segment_id)
        const entry = out.warrant.entries.find((e) => e.segment_id === d.segment_id)
        assert.equal(entry?.action, 'drop')
        assert.equal(entry?.source.kind, 'rule')
        assert.equal(entry?.source.name, d.rule_name)
      }
      if (d.label === 'dead_end') {
        const entry = out.warrant.entries.find((e) => e.segment_id === d.segment_id)
        assert.ok(entry?.action === 'collapse' || entry?.action === 'drop', d.segment_id)
        if (entry?.action === 'collapse') {
          assert.equal(
            out.plan.collapsed.some((c) => c.segment_id === d.segment_id),
            true,
            d.segment_id,
          )
          assert.ok((entry.dead_end_summary ?? '').length > 0)
        } else {
          assert.equal(out.plan.dropped.includes(d.segment_id), true, d.segment_id)
        }
      }
    }

    for (const id of ruled.unresolved_ids) {
      assert.equal(out.plan.kept.includes(id), true, id)
      const entry = out.warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.kind, 'rule')
      assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)
    }

    const again = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })
    assert.equal(JSON.stringify(again.plan), JSON.stringify(out.plan))
    assert.equal(JSON.stringify(again.warrant), JSON.stringify(out.warrant))
  })

  it('resolveDistillMode: --no-llm wins; backend or model env enables with_llm', () => {
    assert.equal(resolveDistillMode({ no_llm: true, sessionBackend: new FakeSessionBackend() }), 'no_llm')
    assert.equal(resolveDistillMode({ sessionBackend: new FakeSessionBackend() }), 'with_llm')
    assert.equal(
      resolveDistillMode({ env: { TRACE_DISTILLER_MODEL_HOLE_A: 'anthropic/claude' } }),
      'with_llm',
    )
    assert.equal(resolveDistillMode({ env: {} }), 'no_llm')
  })
})

function fakeResult(
  opts: {
    json?: unknown
    tool_calls?: SessionPromptResult['tool_calls']
    role?: SessionPromptResult['usage']['role']
  } = {},
): SessionPromptResult {
  const json = opts.json ?? null
  return {
    text: json === null ? '' : JSON.stringify(json),
    json,
    tool_calls: opts.tool_calls ?? [],
    usage: { role: opts.role ?? 'hole_a_skeleton', input_tokens: 4, output_tokens: 2 },
  }
}

function parseWindowIds(text: string): string[] {
  const match = text.match(/window_segment_ids:\s*(\[[^\]]*\])/)
  if (match?.[1] === undefined) return []
  return JSON.parse(match[1]) as string[]
}

function skeletonPayload(nodes: Skeleton['nodes'], scenario = 'test_fix'): Record<string, unknown> {
  return {
    kind: SKELETON_PASS_JSON_KIND,
    intent: { text: 'Fix add so 1+1 equals 2' },
    scenario,
    skeleton: { nodes },
  }
}

function labelingBackend(opts: {
  nodes: Skeleton['nodes']
  scenario?: string
  holeB: 'label_all' | 'throw' | 'no_calls'
}): FakeSessionBackend {
  return new FakeSessionBackend((input: SessionPromptInput, session: ResolvedSessionOpts) => {
    if (session.role === 'hole_a_skeleton') {
      const json = skeletonPayload(opts.nodes, opts.scenario)
      return fakeResult({ json, role: session.role })
    }
    if (opts.holeB === 'throw') {
      throw new Error('window boom')
    }
    if (opts.holeB === 'no_calls') {
      return fakeResult({ role: session.role, tool_calls: [] })
    }
    const ids = parseWindowIds(input.text)
    return fakeResult({
      role: session.role,
      tool_calls: ids.map((segment_id) => ({
        name: 'label_segment',
        arguments: { segment_id, label: 'useful_exploration', confidence: 0.72 },
      })),
    })
  })
}

describe('orchestrator with_llm', () => {
  afterEach(() => {
    setSessionBackend(undefined)
  })

  it('fake backend end-to-end: intent/skeleton written back, llm labels, plan assembled', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const keepId = ruled.unresolved_ids[0]
    assert.ok(keepId)
    const backend = labelingBackend({
      nodes: [
        {
          id: 'n-keep',
          kind: 'turning_point',
          segment_ids: [keepId],
          note: 'unresolved stays on path',
        },
      ],
      holeB: 'label_all',
    })

    const out = await distill({
      raw,
      profile: DEFAULT_CUT_PROFILE,
      mode: 'with_llm',
      opts: { sessionBackend: backend },
    })

    assert.equal(out.view.intent_hypothesis.text, 'Fix add so 1+1 equals 2')
    assert.equal(out.view.intent_hypothesis.scenario, 'test_fix')
    assert.ok(out.view.skeleton.nodes.some((n) => n.id === 'n-keep'))
    assert.equal(out.plan.trace_id, raw.meta.trace_id)
    assert.ok(out.training.turns.length > 0)
    assert.ok(out.playback.cards.length > 0)

    const llmLabeled = out.decisions.filter((d) => d.source.kind === 'llm')
    assert.equal(llmLabeled.length, ruled.unresolved_ids.length)
    for (const d of llmLabeled) {
      assert.equal(d.label, 'useful_exploration')
      assert.equal(d.source.name, 'test_fix')
      assert.equal(out.plan.kept.includes(d.segment_id), true, d.segment_id)
      const entry = out.warrant.entries.find((e) => e.segment_id === d.segment_id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.kind, 'llm')
    }

    for (const d of ruled.decisions) {
      if (d.label === 'routine') {
        assert.equal(out.plan.dropped.includes(d.segment_id), true)
      }
      if (d.label === 'dead_end') {
        const entry = out.warrant.entries.find((e) => e.segment_id === d.segment_id)
        assert.ok(entry?.action === 'collapse' || entry?.action === 'drop', d.segment_id)
        if (entry?.action === 'collapse') {
          assert.equal(out.plan.collapsed.some((c) => c.segment_id === d.segment_id), true)
        } else {
          assert.equal(out.plan.dropped.includes(d.segment_id), true)
        }
      }
    }

    const holeBCalls = backend.calls.filter((c) => c.role === 'hole_b_label')
    assert.equal(holeBCalls.length, Math.ceil(ruled.unresolved_ids.length / LABEL_WINDOW_SIZE))
    assert.deepEqual(out.unresolved_ids, [])
    assert.ok((out.hole_a_plus_b_tokens ?? 0) > 0)

    const again = await distill({
      raw,
      profile: DEFAULT_CUT_PROFILE,
      mode: 'with_llm',
      opts: {
        sessionBackend: labelingBackend({
          nodes: [{ id: 'n-keep', kind: 'turning_point', segment_ids: [keepId], note: '' }],
          holeB: 'label_all',
        }),
      },
    })
    assert.equal(JSON.stringify(again.plan), JSON.stringify(out.plan))
  })

  it('window failure Fail-Closed Keep with source name fail_closed_keep', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const backend = labelingBackend({
      nodes: [{ id: 'n1', kind: 'main_path_hypothesis', segment_ids: [ruled.unresolved_ids[0] ?? ''], note: '' }],
      holeB: 'throw',
    })

    const out = await distill({
      raw,
      profile: DEFAULT_CUT_PROFILE,
      mode: 'with_llm',
      opts: { sessionBackend: backend },
    })

    assert.deepEqual(out.unresolved_ids, ruled.unresolved_ids)
    for (const id of ruled.unresolved_ids) {
      assert.equal(out.plan.kept.includes(id), true, id)
      const entry = out.warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)
    }
    assert.equal(out.decisions.some((d) => d.source.kind === 'llm'), false)
    assert.ok(out.hole_notes && out.hole_notes.length > 0)
    assert.match(out.hole_notes[0]!, /hole_b_window_failed/)
    assert.match(out.hole_notes[0]!, /window boom/)
    assert.ok((out.hole_a_plus_b_tokens ?? 0) > 0)

    const silent = labelingBackend({
      nodes: [{ id: 'n1', kind: 'main_path_hypothesis', segment_ids: [ruled.unresolved_ids[0] ?? ''], note: '' }],
      holeB: 'no_calls',
    })
    const silentOut = await distill({
      raw,
      profile: DEFAULT_CUT_PROFILE,
      mode: 'with_llm',
      opts: { sessionBackend: silent },
    })
    for (const id of ruled.unresolved_ids) {
      const entry = silentOut.warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)
    }
  })

  it('blind review fills missing skeleton nodes as keep, at most REVIEW_MAX_ROUNDS', async () => {
    assert.equal(REVIEW_MAX_ROUNDS, 2)
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const dropped = ruled.decisions.filter((d) => d.label === 'routine').map((d) => d.segment_id)
    assert.ok(dropped.length >= 1)
    const fillTarget = dropped[0]
    assert.ok(fillTarget)

    const backend = labelingBackend({
      nodes: [
        {
          id: 'n-missing',
          kind: 'verification_anchor',
          segment_ids: [fillTarget],
          note: 'dropped by rules, must fill keep',
        },
      ],
      holeB: 'label_all',
    })

    const out = await distill({
      raw,
      profile: DEFAULT_CUT_PROFILE,
      mode: 'with_llm',
      opts: { sessionBackend: backend },
    })

    assert.equal(out.plan.kept.includes(fillTarget), true)
    assert.equal(out.plan.dropped.includes(fillTarget), false)
    const entry = out.warrant.entries.find((e) => e.segment_id === fillTarget)
    assert.equal(entry?.action, 'keep')
    assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)

    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels: ruled.decisions,
      view: ruled.view,
      profile: DEFAULT_CUT_PROFILE,
    })
    const view = {
      ...ruled.view,
      skeleton: {
        version: 0,
        nodes: dropped.map((id, i) => ({
          id: `n-drop-${String(i)}`,
          kind: 'turning_point' as const,
          segment_ids: [id],
          note: '',
        })),
      },
    }
    const reviewed = runBlindReviewFillIn({
      raw,
      view,
      warrant,
      profile: DEFAULT_CUT_PROFILE,
    })
    assert.ok(reviewed.rounds >= 1)
    assert.ok(reviewed.rounds <= REVIEW_MAX_ROUNDS)
    for (const id of dropped) {
      assert.equal(reviewed.assembled.plan.kept.includes(id), true, id)
    }
    const third = runBlindReviewFillIn({
      raw,
      view,
      warrant: reviewed.warrant,
      profile: DEFAULT_CUT_PROFILE,
    })
    assert.equal(third.rounds, 0)
    assert.equal(
      fillInKeepWarrant(reviewed.warrant, dropped).entries.filter((e) => e.action === 'keep').length,
      reviewed.warrant.entries.filter((e) => e.action === 'keep').length,
    )
  })
})

