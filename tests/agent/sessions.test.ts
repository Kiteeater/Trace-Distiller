import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { HOLE_TOOL_NAMES, handleReadSegment } from '../../src/agent/extension.ts'
import { writeWarrant } from '../../src/agent/sessions/write_warrant.ts'
import {
  SKELETON_PASS_JSON_KIND,
  openQaSession,
  openReplaySession,
  openReviewSession,
  openSession,
  skeletonPass,
} from '../../src/agent/sessions/skeleton_pass.ts'
import { checkContinuityPair, labelWindow } from '../../src/agent/sessions/label_window.ts'
import {
  FakeSessionBackend,
  setSessionBackend,
  type SessionPromptResult,
} from '../../src/agent/sessions/open_session.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { LABEL_WINDOW_SIZE } from '../../src/constant/window.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../../src/domain/cut_decision.ts'
import { distill } from '../../src/pipeline/orchestrator.ts'
import { applyRules } from '../../src/pipeline/rules.ts'
import { segment } from '../../src/pipeline/segmenter.ts'
import type { LabelDecision } from '../../src/domain/label_decision.ts'
import type { AgentView } from '../../src/types/agent_view.ts'
import type { RawTrace } from '../../src/types/raw_trace.ts'
import type { SegmentCard } from '../../src/types/segment.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const fixtures = join(here, '../fixtures/claude_code')
const sessionsDir = join(here, '../../src/agent/sessions')

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) {
      if (name === 'node_modules') continue
      out.push(...walkTs(path))
    } else if (name.endsWith('.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('writeWarrant', () => {
  it('matches no_llm distill: resolved drop/collapse, unresolved fail-closed keep', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels: ruled.decisions,
      view: ruled.view,
      profile: DEFAULT_CUT_PROFILE,
    })
    const out = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })

    assert.deepEqual(warrant, out.warrant)
    assert.deepEqual(
      warrant.entries.map((e) => e.segment_id),
      ruled.view.segments.map((s) => s.id),
    )

    for (const d of ruled.decisions) {
      const entry = warrant.entries.find((e) => e.segment_id === d.segment_id)
      if (d.label === 'routine') {
        assert.equal(entry?.action, 'drop')
        assert.equal(entry?.source.kind, 'rule')
        assert.equal(entry?.source.name, d.rule_name)
      }
      if (d.label === 'dead_end') {
        assert.equal(entry?.action, 'collapse')
        assert.ok((entry?.dead_end_summary ?? '').length > 0)
      }
    }

    for (const id of ruled.unresolved_ids) {
      const entry = warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.kind, 'rule')
      assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)
    }
  })

  it('maps llm LabelDecision through decideCut instead of fail-closed', () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const first = ruled.view.segments[0]
    assert.ok(first)
    const labels: LabelDecision[] = [
      ...ruled.decisions.filter((d) => d.segment_id !== first.id),
      {
        segment_id: first.id,
        label: 'key_decision',
        source: { kind: 'llm', name: 'draft_skill' },
        confidence: 0.8,
      },
    ]
    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels,
      view: ruled.view,
      profile: DEFAULT_CUT_PROFILE,
    })
    const entry = warrant.entries.find((e) => e.segment_id === first.id)
    assert.equal(entry?.action, 'keep')
    assert.equal(entry?.source.kind, 'llm')
    assert.equal(entry?.source.name, 'draft_skill')
    assert.equal(entry?.confidence, 0.8)
  })
})

afterEach(() => {
  setSessionBackend(undefined)
})

const MIDDLE_SECRET = 'MIDDLE_FULL_SECRET_SHOULD_NOT_ENTER_PROMPT_zzzz'
const OTHER_SECRET = 'OTHER_SEGMENT_FULL_TEXT_ONLY_VIA_READ_SEGMENT'

function card(id: string, refs: string[], head: string): SegmentCard {
  return {
    id,
    tool: 'Read',
    sig: `Read:${id}`,
    outcome: 'ok',
    rep_of: null,
    reads: [],
    writes: [],
    tokens: 3,
    focus: 'card',
    head,
    raw_refs: refs,
  }
}

function rawOf(turns: RawTrace['turns']): RawTrace {
  return {
    meta: {
      trace_id: 't-holes',
      source: 'claude-code',
      ground_truth_ref: 'g',
      total_tokens: 12,
    },
    ground_truth: { kind: 'tests_passed', evidence_ref: 'g' },
    turns,
    anchor_turn_ids: ['head-1', 'ver-1'],
  }
}

function viewOf(raw: RawTrace, segments: SegmentCard[]): AgentView {
  return {
    meta: raw.meta,
    intent_hypothesis: { version: 0, text: '' },
    skeleton: { version: 0, nodes: [] },
    segments,
  }
}

function holeFixture(): { raw: RawTrace; view: AgentView } {
  const raw = rawOf([
    { id: 'head-1', role: 'user', content: 'HEAD_TASK_FIX_ADD', tokens: 2 },
    {
      id: 'mid-1',
      role: 'assistant',
      content: `short middle head\n${MIDDLE_SECRET.repeat(4)}`,
      tokens: 4,
    },
    { id: 'ver-1', role: 'tool_result', content: 'VERIFY_PYTEST_PASSED', tokens: 2 },
    { id: 'other-1', role: 'tool_result', content: OTHER_SECRET, tokens: 2 },
  ])
  const view = viewOf(raw, [
    card('s0001', ['head-1'], 'HEAD_TASK_FIX_ADD'),
    card('s0002', ['mid-1'], 'short middle head'),
    card('s0003', ['ver-1'], 'VERIFY_PYTEST_PASSED'),
    card('s0004', ['other-1'], 'other card'),
  ])
  return { raw, view }
}

function skeletonJson(scenario = 'test_fix'): Record<string, unknown> {
  return {
    kind: SKELETON_PASS_JSON_KIND,
    intent: { text: 'Fix add so 1+1 equals 2' },
    scenario,
    skeleton: {
      nodes: [
        {
          id: 'n1',
          kind: 'turning_point',
          segment_ids: ['s0002'],
          note: 'edit add',
        },
      ],
    },
  }
}

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
    usage: { role: opts.role ?? 'hole_a_skeleton', input_tokens: 11, output_tokens: 5 },
  }
}

describe('hole sessions', () => {
  it('skeletonPass reads only head+verification turns plus card index, not full raw.turns', async () => {
    const { raw, view } = holeFixture()
    const json = skeletonJson()
    const fake = new FakeSessionBackend((_input, opts) => fakeResult({ json, role: opts.role }))
    const out = await skeletonPass({
      trace_id: raw.meta.trace_id,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
      raw,
      view,
      backend: fake,
    })

    assert.equal(out.intent.version, 0)
    assert.equal(out.intent.text, 'Fix add so 1+1 equals 2')
    assert.equal(out.scenario, 'test_fix')
    assert.equal(out.intent.scenario, 'test_fix')
    assert.equal(out.skeleton.version, 0)
    assert.equal(out.skeleton.nodes[0]?.kind, 'turning_point')
    assert.equal(out.usage.role, 'hole_a_skeleton')
    assert.equal(out.usage.input_tokens, 11)

    const composed = fake.calls[0]?.composed ?? ''
    assert.match(composed, /HEAD_TASK_FIX_ADD/)
    assert.match(composed, /VERIFY_PYTEST_PASSED/)
    assert.match(composed, /s0002/)
    assert.doesNotMatch(composed, new RegExp(MIDDLE_SECRET))
    assert.doesNotMatch(composed, new RegExp(OTHER_SECRET))
    assert.equal(composed.includes(JSON.stringify(raw.turns)), false)
    assert.equal(fake.calls[0]?.role, 'hole_a_skeleton')
  })

  it('skeletonPass falls back illegal scenario to implement', async () => {
    const { raw, view } = holeFixture()
    const json = skeletonJson('hotfix')
    const fake = new FakeSessionBackend(() => fakeResult({ json }))
    const out = await skeletonPass({
      trace_id: raw.meta.trace_id,
      head_turn_ids: ['head-1'],
      verification_turn_ids: ['ver-1'],
      raw,
      view,
      backend: fake,
    })
    assert.equal(out.scenario, 'implement')
    assert.equal(out.intent.scenario, 'implement')
  })

  it('labelWindow collects llm LabelDecision from tool_calls and leaves unlabeled ids alone', async () => {
    const { raw, view } = holeFixture()
    const fake = new FakeSessionBackend((_input, opts) =>
      fakeResult({
        role: opts.role,
        tool_calls: [
          {
            name: 'read_segment',
            arguments: { segment_id: 's0001' },
          },
          {
            name: 'label_segment',
            arguments: { segment_id: 's0001', label: 'key_decision', confidence: 0.9 },
          },
        ],
      }),
    )
    const out = await labelWindow({
      segment_ids: ['s0001', 's0002'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: { version: 0, text: 'fix add' },
      skill_path: 'agent/skills/implement.md',
      skill_text: 'Call label_segment per id. 禁止执行类工具.',
      backend: fake,
    })

    assert.equal(fake.calls.length, 1)
    assert.deepEqual([...fake.calls[0]!.tools], [...HOLE_TOOL_NAMES])
    assert.equal(out.usage.role, 'hole_b_label')
    assert.equal(out.decisions.length, 1)
    assert.deepEqual(out.decisions[0], {
      segment_id: 's0001',
      label: 'key_decision',
      source: { kind: 'llm', name: 'implement' },
      confidence: 0.9,
    })
    assert.deepEqual(out.still_unlabeled, ['s0002'])

    const composed = fake.calls[0]?.composed ?? ''
    assert.match(composed, /Call label_segment per id/)
    assert.match(composed, /s0001/)
    assert.match(composed, /s0002/)
    assert.doesNotMatch(composed, new RegExp(MIDDLE_SECRET))
    assert.doesNotMatch(composed, new RegExp(OTHER_SECRET))
    assert.doesNotMatch(composed, /s0004/)

    const read = handleReadSegment(
      { cards: view.segments.filter((s) => s.id === 's0001' || s.id === 's0002'), raw },
      { segment_id: 's0001' },
    )
    assert.equal(read.ok, true)
    if (read.ok) {
      assert.equal(read.text.includes(MIDDLE_SECRET), false)
      assert.equal(read.text.includes(OTHER_SECRET), false)
      assert.match(read.text, /HEAD_TASK_FIX_ADD/)
    }
  })

  it('labelWindow rejects illegal labels and fails when no label_segment is called', async () => {
    const { raw, view } = holeFixture()
    const illegal = new FakeSessionBackend(() =>
      fakeResult({
        role: 'hole_b_label',
        tool_calls: [
          {
            name: 'label_segment',
            arguments: { segment_id: 's0001', label: 'important', confidence: 1 },
          },
        ],
      }),
    )
    const rejected = await labelWindow({
      segment_ids: ['s0001'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: { version: 0, text: 'fix add' },
      skill_path: 'agent/skills/debug.md',
      skill_text: 'label_segment only',
      backend: illegal,
    })
    assert.deepEqual(rejected.decisions, [])
    assert.deepEqual(rejected.still_unlabeled, ['s0001'])

    const silent = new FakeSessionBackend(() => fakeResult({ role: 'hole_b_label', tool_calls: [] }))
    await assert.rejects(
      () =>
        labelWindow({
          segment_ids: ['s0001'],
          view,
          raw,
          skeleton: view.skeleton,
          intent: { version: 0, text: 'fix add' },
          skill_path: 'agent/skills/debug.md',
          skill_text: 'label_segment only',
          backend: silent,
        }),
      /no label_segment/,
    )
  })

  it('labelWindow opens a new session per window and rejects oversized windows', async () => {
    const { raw, view } = holeFixture()
    const fake = new FakeSessionBackend(() =>
      fakeResult({
        role: 'hole_b_label',
        tool_calls: [
          {
            name: 'label_segment',
            arguments: { segment_id: 's0001', label: 'routine', confidence: 0.4 },
          },
        ],
      }),
    )
    await labelWindow({
      segment_ids: ['s0001'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: { version: 0, text: 'a' },
      skill_path: 'implement.md',
      skill_text: 'skill a',
      backend: fake,
    })
    await labelWindow({
      segment_ids: ['s0002'],
      view,
      raw,
      skeleton: view.skeleton,
      intent: { version: 0, text: 'b' },
      skill_path: 'implement.md',
      skill_text: 'skill b',
      backend: fake,
    })
    assert.equal(fake.calls.length, 2)

    const tooMany = Array.from({ length: LABEL_WINDOW_SIZE + 1 }, (_, i) => `s${String(i)}`)
    await assert.rejects(
      () =>
        labelWindow({
          segment_ids: tooMany,
          view,
          raw,
          skeleton: view.skeleton,
          intent: { version: 0, text: 'x' },
          skill_path: 'implement.md',
          skill_text: 'skill',
          backend: fake,
        }),
      /LABEL_WINDOW_SIZE/,
    )
  })

  it('checkContinuityPair reuses hole B tools and does not invent a score', async () => {
    const { view } = holeFixture()
    const left = view.segments[0]
    const right = view.segments[1]
    assert.ok(left)
    assert.ok(right)
    const fake = new FakeSessionBackend((_input, opts) =>
      fakeResult({
        role: opts.role,
        tool_calls: [
          {
            name: 'check_continuity',
            arguments: {
              left_id: left.id,
              right_id: right.id,
              reachable: true,
              score: 4,
              reason: 'same file',
            },
          },
        ],
      }),
    )
    const got = await checkContinuityPair(left, right, view.skeleton, fake)
    assert.equal(got.ok, true)
    assert.equal(got.score, 4)
    assert.equal(got.reason, 'same file')
    assert.equal(got.usage.role, 'hole_b_label')
    assert.deepEqual([...fake.calls[0]!.tools], [...HOLE_TOOL_NAMES])

    const silent = new FakeSessionBackend(() => fakeResult({ role: 'hole_b_label' }))
    await assert.rejects(
      () => checkContinuityPair(left, right, view.skeleton, silent),
      /no check_continuity/,
    )
  })

  it('openSession factories still expose role-specific handles', () => {
    const a = openSession({ role: 'hole_a_skeleton', model: 'anthropic/claude-opus-4-5' })
    const review = openReviewSession({ model: 'openai/gpt-4o-mini' })
    const replay = openReplaySession({ model: 'openai/gpt-4o-mini' })
    const qa = openQaSession({ model: 'openai/gpt-4o-mini' })
    assert.equal(a.role, 'hole_a_skeleton')
    assert.equal(review.role, 'l4_review')
    assert.equal(replay.role, 'l4_replay')
    assert.equal(qa.role, 'l4_qa')
    a.dispose()
    review.dispose()
    replay.dispose()
    qa.dispose()
  })

  it('createAgentSession only appears under src/agent/sessions', () => {
    const files = walkTs(sessionsDir)
    assert.ok(files.length >= 4)
    const openSrc = readFileSync(join(sessionsDir, 'open_session.ts'), 'utf8')
    assert.match(openSrc, /createAgentSession/)
    assert.match(openSrc, /@mariozechner\/pi-coding-agent/)
    assert.match(openSrc, /SessionManager\.inMemory/)
    assert.match(openSrc, /noTools/)

    const warrant = readFileSync(join(sessionsDir, 'write_warrant.ts'), 'utf8')
    assert.doesNotMatch(warrant, /createAgentSession/)
    assert.doesNotMatch(warrant, /@mariozechner\/pi/)

    for (const root of [join(repoRoot, 'src'), join(repoRoot, 'script')]) {
      for (const path of walkTs(root)) {
        if (path.includes(`${join('src', 'agent', 'sessions')}`)) continue
        const src = readFileSync(path, 'utf8')
        const imports = src
          .split('\n')
          .filter((line) => /^\s*import\s/.test(line))
          .join('\n')
        assert.doesNotMatch(imports, /createAgentSession/)
        assert.doesNotMatch(imports, /@mariozechner\/pi/)
        assert.doesNotMatch(imports, /from ['"]pi['"]/)
      }
    }
  })
})
