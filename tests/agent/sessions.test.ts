import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { writeWarrant } from '../../src/agent/sessions/write_warrant.ts'
import {
  NotImplementedError,
  openQaSession,
  openReplaySession,
  openReviewSession,
  openSession,
  skeletonPass,
} from '../../src/agent/sessions/skeleton_pass.ts'
import { checkContinuityPair, labelWindow } from '../../src/agent/sessions/label_window.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../../src/domain/cut_decision.ts'
import { distill } from '../../src/pipeline/orchestrator.ts'
import { applyRules } from '../../src/pipeline/rules.ts'
import { segment } from '../../src/pipeline/segmenter.ts'
import type { LabelDecision } from '../../src/domain/label_decision.ts'
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

describe('hole sessions', () => {
  it('skeletonPass / labelWindow / continuity still throw NotImplementedError', async () => {
    const raw = parse(load('single_task_pytest.jsonl'))
    const view = segment(raw)
    const card: SegmentCard = view.segments[0] ?? {
      id: 's0001',
      tool: 'Read',
      sig: 'Read:x',
      outcome: 'ok',
      rep_of: null,
      reads: [],
      writes: [],
      tokens: 1,
      focus: 'card',
      head: 'h',
      raw_refs: [],
    }

    await assert.rejects(
      () =>
        skeletonPass({
          trace_id: raw.meta.trace_id,
          head_turn_ids: raw.anchor_turn_ids,
          verification_turn_ids: [],
          raw,
          view,
        }),
      (err: unknown) =>
        err instanceof NotImplementedError && String(err.message).includes('pi spike'),
    )
    await assert.rejects(
      () =>
        labelWindow({
          segment_ids: view.segments.map((s) => s.id),
          view,
          raw,
          skeleton: view.skeleton,
          intent: view.intent_hypothesis,
          skill_path: 'draft.md',
        }),
      (err: unknown) =>
        err instanceof NotImplementedError && String(err.message).includes('pi spike'),
    )
    await assert.rejects(
      () => checkContinuityPair(card, card, view.skeleton),
      (err: unknown) => err instanceof NotImplementedError,
    )
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
