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
  type ResolvedSessionOpts,
  type SessionPromptInput,
  type SessionPromptResult,
} from '../../src/agent/sessions/open_session.ts'
import { applyRules } from '../../src/pipeline/rules.ts'
import { segment } from '../../src/pipeline/segmenter.ts'
import type { IntentHypothesis } from '../../src/types/agent_view.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

function fakeResult(
  opts: {
    tool_calls?: SessionPromptResult['tool_calls']
    role?: SessionPromptResult['usage']['role']
  } = {},
): SessionPromptResult {
  return {
    text: '',
    json: null,
    tool_calls: opts.tool_calls ?? [],
    usage: { role: opts.role ?? 'hole_b_label', input_tokens: 6, output_tokens: 3 },
  }
}

function parseWindowIds(text: string): string[] {
  const match = text.match(/window_segment_ids:\s*(\[[^\]]*\])/)
  if (match?.[1] === undefined) return []
  return JSON.parse(match[1]) as string[]
}

describe('cutBrain', () => {
  it('opens hole_b_label with the full cut-brain tool allowlist', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const backend = new FakeSessionBackend()
    const intent: IntentHypothesis = { text: 'fix', scenario: 'test_fix', version: 0 }
    await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent,
      skill_path: 'src/agent/skills/test_fix.md',
      backend,
    })
    assert.ok(backend.calls.length > 0)
    assert.equal(backend.calls[0]!.role, 'hole_b_label')
    assert.deepEqual([...backend.calls[0]!.tools].sort(), [...CUT_BRAIN_TOOL_NAMES].sort())
    assert.deepEqual([...HOLE_TOOL_NAMES].sort(), [...CUT_BRAIN_TOOL_NAMES].sort())
  })

  it('adopts applyRules only after apply_rules_hint; then labels remaining', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const ruled = applyRules({ view, raw })
    const backend = new FakeSessionBackend()
    const out = await cutBrain({
      segment_ids: view.segments.map((s) => s.id),
      view,
      raw,
      skeleton: view.skeleton,
      intent: { text: 'fix add', scenario: 'test_fix', version: 0 },
      skill_path: 'src/agent/skills/test_fix.md',
      backend,
    })

    assert.equal(out.rules_hint_applied, true)
    const ruleIds = new Set(ruled.decisions.map((d) => d.segment_id))
    for (const d of out.decisions) {
      if (ruleIds.has(d.segment_id)) {
        assert.equal(d.source.kind, 'rule')
      } else {
        assert.equal(d.source.kind, 'llm')
        assert.equal(d.label, 'useful_exploration')
      }
    }
    assert.deepEqual(out.still_unresolved, [])
    assert.ok(backend.calls.some((c) => c.input.text.includes('apply_rules_hint')))
    const composed = backend.calls.map((c) => c.composed).join('\n')
    // Masked follow-up, not full rule payloads.
    assert.match(composed, /MASKED_TOOL_RESULTS/)
    assert.match(composed, /apply_rules_hint/)
  })

  it('keeps unresolved until explicit keep_segment (no silent rules)', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const ids = view.segments.map((s) => s.id)
    const keepId = ids[0]!
    const backend = new FakeSessionBackend((input: SessionPromptInput, opts: ResolvedSessionOpts) => {
      void opts
      const windowIds = parseWindowIds(input.text)
      const target = windowIds[0] ?? keepId
      return fakeResult({
        tool_calls: [{ name: 'keep_segment', arguments: { segment_id: target, confidence: 0.9 } }],
      })
    })
    const out = await cutBrain({
      segment_ids: ids,
      view,
      raw,
      skeleton: view.skeleton,
      intent: { text: 'fix', scenario: 'test_fix', version: 0 },
      skill_path: 'src/agent/skills/test_fix.md',
      backend,
      max_rounds: 2,
    })
    assert.equal(out.rules_hint_applied, false)
    assert.equal(out.decisions.length >= 1, true)
    assert.equal(out.decisions[0]!.source.name, 'keep_segment')
    assert.equal(out.decisions[0]!.label, 'key_decision')
    assert.ok(out.still_unresolved.length > 0)
    assert.equal(out.still_unresolved.includes(out.decisions[0]!.segment_id), false)
  })

  it('does not adopt rules when the agent never calls apply_rules_hint', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const view = segment(raw)
    const ids = view.segments.map((s) => s.id)
    const backend = new FakeSessionBackend((input: SessionPromptInput) => {
      const windowIds = parseWindowIds(input.text)
      return fakeResult({
        tool_calls: windowIds.map((segment_id) => ({
          name: 'label_segment',
          arguments: { segment_id, label: 'dead_end', confidence: 0.4 },
        })),
      })
    })
    const out = await cutBrain({
      segment_ids: ids,
      view,
      raw,
      skeleton: view.skeleton,
      intent: { text: 'fix', scenario: 'test_fix', version: 0 },
      skill_path: 'src/agent/skills/test_fix.md',
      backend,
      max_rounds: 1,
    })
    assert.equal(out.rules_hint_applied, false)
    assert.equal(out.decisions.every((d) => d.source.kind === 'llm'), true)
    assert.equal(out.decisions.every((d) => d.label === 'dead_end'), true)
  })
})
