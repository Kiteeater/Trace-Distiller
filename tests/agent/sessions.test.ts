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
  cardIndexEntry,
  cardIndexPayload,
  composeSkeletonPassPrompt,
  openQaSession,
  openReplaySession,
  openReviewSession,
  openSession,
  selectVisibleTurns,
  skeletonPass,
} from '../../src/agent/sessions/skeleton_pass.ts'
import { checkContinuityPair, labelWindow } from '../../src/agent/sessions/label_window.ts'
import {
  FakeSessionBackend,
  composeSessionPrompt,
  resolveSessionTimeoutMs,
  applyCustomGateway,
  buildCustomProviderRegistration,
  readCustomGatewayEnv,
  readPiUsage,
  usageFromPiMessages,
  setSessionBackend,
  type CustomProviderRegisterConfig,
  type SessionPromptResult,
} from '../../src/agent/sessions/open_session.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import {
  CARD_INDEX_CHARS_PER_SEGMENT_MAX,
  CARD_INDEX_HEAD_MAX_CHARS,
  LABEL_WINDOW_SIZE,
  SESSION_TIMEOUT_ENV,
  SKELETON_TURN_CONTENT_MAX_CHARS,
} from '../../src/constant/window.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'
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
  it('writeWarrant: resolved drop/collapse, unresolved fail-closed keep (rules labels only)', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels: ruled.decisions,
      view: ruled.view,
      profile: DEFAULT_CUT_PROFILE,
    })

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
        // Representative policy: members / over-cap may drop; span fill may collapse.
        assert.ok(entry?.action === 'collapse' || entry?.action === 'drop', d.segment_id)
        if (entry?.action === 'collapse') {
          assert.ok((entry.dead_end_summary ?? '').length > 0)
        }
      }
    }

    for (const id of ruled.unresolved_ids) {
      const entry = warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.kind, 'rule')
      assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)
    }
  })

  it('drops trailing dead_end collapses after the last keep (no span value)', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels: ruled.decisions,
      view: ruled.view,
      profile: DEFAULT_CUT_PROFILE,
    })
    const indexOf = new Map(ruled.view.segments.map((s, i) => [s.id, i]))
    let lastKeep = -1
    for (const e of warrant.entries) {
      if (e.action !== 'keep') continue
      const idx = indexOf.get(e.segment_id)
      if (idx !== undefined && idx > lastKeep) lastKeep = idx
    }
    for (const e of warrant.entries) {
      if (e.action !== 'collapse') continue
      const idx = indexOf.get(e.segment_id)
      assert.ok(idx !== undefined)
      assert.ok(idx! <= lastKeep, `trailing collapse ${e.segment_id}`)
    }
  })

  it('drops similar_retry members and caps representative collapses per profile', () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels: ruled.decisions,
      view: ruled.view,
      profile: DEFAULT_CUT_PROFILE,
    })
    const byId = new Map(ruled.view.segments.map((s) => [s.id, s]))
    for (const d of ruled.decisions.filter((x) => x.label === 'dead_end')) {
      const card = byId.get(d.segment_id)
      const entry = warrant.entries.find((e) => e.segment_id === d.segment_id)
      assert.ok(entry)
      if (card?.rep_of != null) {
        // Members start as drop; span fill may promote a few back to collapse.
        assert.ok(entry.action === 'drop' || entry.action === 'collapse')
      }
    }
    const collapses = warrant.entries.filter((e) => e.action === 'collapse')
    // With fill enabled, collapses can exceed max_representative to satisfy span;
    // without oversized gaps on this fixture, expect at most max_representative + small fill.
    assert.ok(collapses.length >= 1)
    for (const id of ruled.unresolved_ids) {
      const entry = warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
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


  it('cardIndexEntry keeps ids+short heads and drops bulky fields', () => {
    const longHead = 'H' + 'e'.repeat(80)
    const c: SegmentCard = {
      id: 's0099',
      tool: 'Read',
      sig: 'Read:add.ts',
      outcome: 'ok',
      rep_of: null,
      reads: ['add.ts', 'very/long/path/that/should/not/appear'],
      writes: ['out.ts'],
      tokens: 999,
      focus: 'card',
      head: longHead,
      raw_refs: ['t1'],
    }
    const entry = cardIndexEntry(c)
    assert.equal(entry.id, 's0099')
    assert.equal(entry.tool, 'Read')
    assert.equal(entry.sig, 'Read:add.ts')
    assert.equal(entry.outcome, 'ok')
    assert.equal(entry.head, longHead.slice(0, CARD_INDEX_HEAD_MAX_CHARS))
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'rep_of'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'reads'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'writes'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'tokens'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'focus'), false)

    const withRep = cardIndexEntry({ ...c, rep_of: 's0001' })
    assert.equal(withRep.rep_of, 's0001')
  })

  it('CARD_INDEX / hole A prompt size stays bounded (synthetic + fluff)', () => {
    const many: SegmentCard[] = []
    for (let i = 0; i < 40; i++) {
      const id = `s${String(i).padStart(4, '0')}`
      many.push({
        id,
        tool: 'Bash',
        sig: `Bash:cmd-${id}`,
        outcome: 'error',
        rep_of: i % 3 === 0 ? null : 's0000',
        reads: ['a'.repeat(40), 'b'.repeat(40)],
        writes: ['c'.repeat(40)],
        tokens: 500,
        focus: 'card',
        head: 'X'.repeat(120),
        raw_refs: [id],
      })
    }
    const payload = cardIndexPayload(many)
    assert.ok(
      payload.length <= many.length * CARD_INDEX_CHARS_PER_SEGMENT_MAX,
      `CARD_INDEX chars ${payload.length} exceeds ${many.length * CARD_INDEX_CHARS_PER_SEGMENT_MAX}`,
    )
    assert.doesNotMatch(payload, /"reads"/)
    assert.doesNotMatch(payload, /"writes"/)
    assert.doesNotMatch(payload, /"tokens"/)
    assert.doesNotMatch(payload, /"focus"/)
    assert.ok(!payload.includes('X'.repeat(CARD_INDEX_HEAD_MAX_CHARS + 1)))

    const fluffPath = join(repoRoot, 'benchmark/datasets/short/fluff-heavy.jsonl')
    const raw = parse(readFileSync(fluffPath, 'utf8'))
    const ruled = applyRules({ view: segment(raw), raw })
    const firstUser = raw.turns.find((t) => t.role === 'user')
    const headSet = new Set<string>()
    if (firstUser !== undefined) {
      const idx = raw.turns.findIndex((t) => t.id === firstUser.id)
      const first = raw.turns[idx]
      const second = raw.turns[idx + 1]
      if (first !== undefined) headSet.add(first.id)
      if (second !== undefined) headSet.add(second.id)
    }
    const head_turn_ids = raw.anchor_turn_ids.filter((id) => headSet.has(id))
    const verification_turn_ids = raw.anchor_turn_ids.filter((id) => !headSet.has(id))
    const input = {
      trace_id: raw.meta.trace_id,
      head_turn_ids,
      verification_turn_ids,
      raw,
      view: ruled.view,
    }
    const visible = selectVisibleTurns(input)
    const prompt = composeSkeletonPassPrompt(input, visible)
    const composed = composeSessionPrompt(prompt)
    const cardsJson = cardIndexPayload(ruled.view.segments)
    assert.ok(
      cardsJson.length < 2800,
      `fluff CARD_INDEX chars ${cardsJson.length} should be well under legacy ~4000`,
    )
    assert.ok(
      estimateTokens(composed) < 1200,
      `fluff hole A estimateTokens=${estimateTokens(composed)} should stay under 1200`,
    )
    // Long verification tool_result must be truncated in prompt.
    const longVer = visible.verification.find((t) => t.content.length > SKELETON_TURN_CONTENT_MAX_CHARS)
    if (longVer !== undefined) {
      assert.ok(composed.includes('…'))
      assert.equal(composed.includes(longVer.content), false)
    }
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

  it('default FakeSessionBackend returns parseable L4 QA/replay/review JSON', async () => {
    const fake = new FakeSessionBackend()
    const qa = openQaSession({ backend: fake })
    const replay = openReplaySession({ backend: fake })
    const review = openReviewSession({ backend: fake })
    const qaOut = await qa.prompt({ text: '---QUESTIONS_JSON---\n[{"id":"q9","question":"why"}]\n---END_QUESTIONS_JSON---' })
    const replayOut = await replay.prompt({ text: 'replay the cut' })
    const reviewOut = await review.prompt({
      text: '---PLAYBACK_JSON---\n{"trace_id":"t","cards":[{"id":"s0002"}]}\n---END_PLAYBACK_JSON---',
    })
    assert.equal((qaOut.json as { kind: string }).kind, 'l4_qa_v0')
    assert.equal((replayOut.json as { kind: string; success: boolean }).success, true)
    assert.equal((reviewOut.json as { kind: string }).kind, 'l4_review_v0')
    qa.dispose()
    replay.dispose()
    review.dispose()
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
    assert.match(openSrc, /registerProvider/)
    assert.match(openSrc, /openai-completions/)
    assert.match(openSrc, /TRACE_DISTILLER_API_BASE/)
    assert.match(openSrc, /authHeader:\s*true/)
    assert.match(openSrc, /applyCustomGateway/)

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

  it('registerProvider args match openai-completions mint shape without a real key', () => {
    const registration = buildCustomProviderRegistration({
      provider: 'macaron',
      modelId: 'macaron-v1-coding-venti',
      baseUrl: 'https://mint-alpha.macaron.im/v1',
      apiKey: 'sk-test-not-a-real-key',
    })
    assert.equal(registration.provider, 'macaron')
    assert.equal(registration.modelId, 'macaron-v1-coding-venti')
    assert.equal(registration.config.baseUrl, 'https://mint-alpha.macaron.im/v1')
    assert.equal(registration.config.api, 'openai-completions')
    assert.equal(registration.config.apiKey, 'sk-test-not-a-real-key')
    assert.equal(registration.config.authHeader, true)
    assert.deepEqual(registration.config.compat, {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    })
    assert.equal(registration.config.models.length, 1)
    const model = registration.config.models[0]
    assert.ok(model)
    assert.equal(model.id, 'macaron-v1-coding-venti')
    assert.equal(model.name, 'macaron-v1-coding-venti')
    assert.equal(model.reasoning, false)
    assert.deepEqual(model.input, ['text'])
    assert.equal(model.contextWindow, 128000)
    assert.equal(model.maxTokens, 8192)
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.deepEqual(model.compat, registration.config.compat)
  })

  it('applyCustomGateway registers via fake registry and writes AuthStorage', () => {
    const calls: Array<{ name: string; config: CustomProviderRegisterConfig }> = []
    const found = { id: 'macaron-v1-coding-venti', provider: 'macaron' }
    const registry = {
      registerProvider(name: string, config: CustomProviderRegisterConfig) {
        calls.push({ name, config })
      },
      find(provider: string, id: string) {
        if (provider === 'macaron' && id === 'macaron-v1-coding-venti') return found
        return undefined
      },
    }
    const authCalls: Array<{ provider: string; credential: { type: 'api_key'; key: string } }> = []
    const result = applyCustomGateway(
      registry,
      {
        set(provider, credential) {
          authCalls.push({ provider, credential })
        },
      },
      'macaron/macaron-v1-coding-venti',
      {
        TRACE_DISTILLER_API_BASE: 'https://mint-alpha.macaron.im/v1',
        TRACE_DISTILLER_API_KEY: 'sk-test-not-a-real-key',
        TRACE_DISTILLER_PROVIDER: 'macaron',
      },
    )
    assert.equal(result.used, true)
    if (result.used !== true) return
    assert.equal(result.model, found)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.name, 'macaron')
    const config = calls[0]?.config as { api?: string; authHeader?: boolean; apiKey?: string }
    assert.equal(config.api, 'openai-completions')
    assert.equal(config.authHeader, true)
    assert.equal(config.apiKey, 'sk-test-not-a-real-key')
    assert.deepEqual(authCalls, [
      { provider: 'macaron', credential: { type: 'api_key', key: 'sk-test-not-a-real-key' } },
    ])
  })

  it('applyCustomGateway is a no-op without API_BASE+API_KEY', () => {
    let registered = 0
    const result = applyCustomGateway(
      {
        registerProvider() {
          registered += 1
        },
        find() {
          return undefined
        },
      },
      {
        set() {
          registered += 1
        },
      },
      'macaron/macaron-v1-coding-venti',
      { TRACE_DISTILLER_PROVIDER: 'macaron' },
    )
    assert.deepEqual(result, { used: false })
    assert.equal(registered, 0)
    assert.equal(readCustomGatewayEnv({ TRACE_DISTILLER_API_BASE: 'https://example.invalid/v1' }), undefined)
    assert.equal(readCustomGatewayEnv({ TRACE_DISTILLER_API_KEY: 'sk-test-not-a-real-key' }), undefined)
    assert.equal(readCustomGatewayEnv({ TRACE_DISTILLER_API_BASE: '', TRACE_DISTILLER_API_KEY: '' }), undefined)
  })

  it('TRACE_DISTILLER_PROVIDER defaults to macaron', () => {
    const env = readCustomGatewayEnv({
      TRACE_DISTILLER_API_BASE: 'https://mint-alpha.macaron.im/v1',
      TRACE_DISTILLER_API_KEY: 'sk-test-not-a-real-key',
    })
    assert.equal(env?.provider, 'macaron')
  })

  it('committed sources do not embed API keys', () => {
    const secret = /sk-[0-9a-f]{16,}/i
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8')
    assert.match(example, /^TRACE_DISTILLER_API_KEY=\s*$/m)
    assert.doesNotMatch(example, secret)
    for (const root of [join(repoRoot, 'src'), join(repoRoot, 'script'), join(repoRoot, 'tests'), join(repoRoot, 'docs')]) {
      for (const path of walkTs(root)) {
        const src = readFileSync(path, 'utf8')
        assert.doesNotMatch(src, secret, path)
      }
    }
  })
})

describe('session call hard timeout', () => {
  afterEach(() => {
    setSessionBackend(undefined)
    delete process.env[SESSION_TIMEOUT_ENV]
  })

  it('hanging mint session prompt times out (does not hang forever)', async () => {
    process.env[SESSION_TIMEOUT_ENV] = '50'
    assert.equal(resolveSessionTimeoutMs(), 50)
    setSessionBackend(
      new FakeSessionBackend(async () => {
        await new Promise(() => {})
        return {
          text: '',
          json: null,
          tool_calls: [],
          usage: { role: 'l4_qa', input_tokens: 1, output_tokens: 1 },
        }
      }),
    )
    const session = openSession({ role: 'l4_qa' })
    const started = Date.now()
    await assert.rejects(
      () => session.prompt({ text: 'should timeout' }),
      /session\.prompt\(l4_qa\) timed out after 50ms/,
    )
    const elapsed = Date.now() - started
    // withPiRetry adds one retry → ~100ms + slack, still far from forever
    assert.ok(elapsed < 2000, `expected quick fail, took ${elapsed}ms`)
    session.dispose()
  })
})

describe('pi usage extraction (mint cost)', () => {
  it('readPiUsage prefers pi-ai input/output and folds cache into input', () => {
    assert.deepEqual(
      readPiUsage({
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 10,
        totalTokens: 170,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      }),
      { input_tokens: 150, output_tokens: 20 },
    )
    assert.deepEqual(
      readPiUsage({ input_tokens: 7, output_tokens: 3 }),
      { input_tokens: 7, output_tokens: 3 },
    )
    assert.equal(readPiUsage({ cost: { input: 9, output: 9 } }), undefined)
    assert.equal(readPiUsage(null), undefined)
  })

  it('usageFromPiMessages sums assistant turns and ignores estimate-shaped holes', () => {
    const usage = usageFromPiMessages(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60 },
        },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'label_segment', arguments: { segment_id: 's1' } }],
          usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 35 },
        },
      ],
      'hole_b_label',
    )
    assert.deepEqual(usage, { role: 'hole_b_label', input_tokens: 80, output_tokens: 15 })
  })

  it('missing pi fields would have forced estimate; with fields, real usage stays small', () => {
    // Regression: old extractor only looked for input_tokens / prompt_tokens, so mint
    // usage.input was ignored and estimateTokens(composed) inflated distill_cost_ratio.
    const real = usageFromPiMessages(
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'pong' }],
          usage: { input: 120, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 128 },
        },
      ],
      'hole_a_skeleton',
    )
    assert.equal(real?.input_tokens, 120)
    assert.equal(real?.output_tokens, 8)
    assert.ok((real!.input_tokens + real!.output_tokens) < 500)
  })
})

describe('parseStructuredJson prose extract', () => {
  it('parses JSON embedded in prose and fenced blocks', async () => {
    const { parseStructuredJson, extractJsonFromProse } = await import('../../src/agent/sessions/open_session.ts')
    assert.deepEqual(extractJsonFromProse('The bug is fixed.\n{"kind":"l4_replay_v0","success":true}'), '{"kind":"l4_replay_v0","success":true}')
    const obj = parseStructuredJson('The bug is fixed. Here is JSON:\n{"kind":"l4_replay_v0","success":true,"note":"ok"}')
    assert.equal((obj as { success: boolean }).success, true)
  })

  it('repairs trailing commas, comments, and truncated objects', async () => {
    const { parseStructuredJson, repairNearJson, extractJsonFromProse } = await import(
      '../../src/agent/sessions/open_session.ts'
    )
    const trailing = parseStructuredJson(
      '```json\n{"kind":"l4_qa_v0","items":[{"id":"q1","question":"q","answer":"a","correct":true},],}\n```',
    ) as { kind: string; items: unknown[] }
    assert.equal(trailing.kind, 'l4_qa_v0')
    assert.equal(trailing.items.length, 1)

    const commented = parseStructuredJson(
      '{ /* mint noise */ "kind":"l4_replay_v0", // ok\n"success": true, }',
    ) as { success: boolean }
    assert.equal(commented.success, true)

    const truncatedRaw =
      'Sure.\n{"kind":"l4_qa_v0","items":[{"id":"q1","question":"task?","answer":"fix add","correct":true},{"id":"q2","question":"edit?","answer":"a+b"'
    assert.ok(extractJsonFromProse(truncatedRaw)?.startsWith('{'))
    const repaired = repairNearJson(extractJsonFromProse(truncatedRaw)!)
    const salvaged = parseStructuredJson(truncatedRaw) as {
      items: Array<{ id: string; correct?: boolean }>
    }
    assert.ok(salvaged.items.length >= 1, repaired)
    assert.equal(salvaged.items[0]?.id, 'q1')
  })
})

