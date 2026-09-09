import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import {
  FakeSessionBackend,
  PiSessionBackend,
  composeSessionPrompt,
  isSpikeLabelJson,
  openSession,
  setSessionBackend,
} from '../../src/agent/sessions/open_session.ts'
import { PI_FAILURE_RETRY } from '../../src/constant/window.ts'
import { segment } from '../../src/pipeline/segmenter.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const fixtures = join(here, '../fixtures/claude_code')
const skillText = readFileSync(join(repoRoot, 'src/agent/skills/implement.md'), 'utf8')

const MODEL_ENV_KEYS = [
  'TRACE_DISTILLER_MODEL_HOLE_A',
  'TRACE_DISTILLER_MODEL_HOLE_B',
  'TRACE_DISTILLER_MODEL_L4',
] as const

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of MODEL_ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(() => {
  setSessionBackend(undefined)
})

describe('pi spike P0', () => {
  it('(a) structured output: fake backend returns JSON matching spike schema and fake tool_calls', async () => {
    const fake = new FakeSessionBackend()
    const handle = openSession({ role: 'hole_b_label', backend: fake, model: 'openai/gpt-4o-mini' })
    const out = await handle.prompt({ text: 'label this window as JSON' })
    assert.equal(isSpikeLabelJson(out.json), true)
    if (!isSpikeLabelJson(out.json)) return
    assert.equal(out.json.kind, 'spike_label')
    assert.equal(out.json.label, 'key_decision')
    assert.equal(out.tool_calls.length, 1)
    assert.equal(out.tool_calls[0]?.name, 'label_segment')
    handle.dispose()
  })

  it('(b) custom message sequence injects skeleton+skill and excludes full RawTrace', async () => {
    const raw = parse(readFileSync(join(fixtures, 'single_task_pytest.jsonl'), 'utf8'))
    const view = segment(raw)
    const banned = ['CHANGELOG.md', 'This physical tail is not the verification point', 'git status']
    for (const needle of banned) {
      assert.ok(
        raw.turns.some((t) => t.content.includes(needle)),
        `fixture should contain ${needle}`,
      )
    }

    const skeletonText = JSON.stringify({
      version: 0,
      nodes: [{ id: 'n0', kind: 'turning_point', segment_ids: [view.segments[0]?.id ?? 's0001'], note: 'fix add' }],
    })
    const head = raw.turns[0]
    assert.ok(head)
    const visible = `${head.role}: ${head.content}`
    assert.match(visible, /Fix the failing test/)
    assert.equal(
      raw.anchor_turn_ids.length > 0,
      true,
      'adapter still marks anchors; sessions must not dump the whole RawTrace',
    )

    const fake = new FakeSessionBackend()
    const handle = openSession({ role: 'hole_a_skeleton', backend: fake, model: 'anthropic/claude-opus-4-5' })
    await handle.prompt({
      skill_text: skillText,
      skeleton_text: skeletonText,
      text: visible,
    })
    const composed = fake.calls[0]?.composed ?? ''
    assert.match(composed, /label_segment/)
    assert.match(composed, /turning_point/)
    assert.match(composed, /fix add/)
    for (const needle of banned) {
      assert.doesNotMatch(composed, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    assert.equal(composeSessionPrompt({ text: visible }).includes('CHANGELOG.md'), false)
    handle.dispose()
  })

  it('(c) same openSession factory switches HOLE_A / HOLE_B / L4 models without caller change', () => {
    const snapshot: Record<string, string | undefined> = {}
    for (const key of MODEL_ENV_KEYS) snapshot[key] = process.env[key]
    const fake = new FakeSessionBackend()
    try {
      process.env.TRACE_DISTILLER_MODEL_HOLE_A = 'anthropic/claude-opus-4-5'
      process.env.TRACE_DISTILLER_MODEL_HOLE_B = 'openai/gpt-4o-mini'
      process.env.TRACE_DISTILLER_MODEL_L4 = 'openai/gpt-4o-mini'

      const holeA = openSession({ role: 'hole_a_skeleton', backend: fake })
      const holeB = openSession({ role: 'hole_b_label', backend: fake })
      const l4 = openSession({ role: 'l4_qa', backend: fake })
      assert.equal(holeA.model, 'anthropic/claude-opus-4-5')
      assert.equal(holeB.model, 'openai/gpt-4o-mini')
      assert.equal(l4.model, 'openai/gpt-4o-mini')
      assert.deepEqual([...holeA.tools], [])
      assert.deepEqual([...holeB.tools], [])

      const override = openSession({ role: 'hole_a_skeleton', backend: fake, model: 'openai/gpt-4o-mini' })
      assert.equal(override.model, 'openai/gpt-4o-mini')
    } finally {
      restoreEnv(snapshot)
    }
  })

  it('retries prompt PI_FAILURE_RETRY extra times then fails', async () => {
    let attempts = 0
    const fake = new FakeSessionBackend(async () => {
      attempts += 1
      throw new Error('provider down')
    })
    const handle = openSession({ role: 'hole_b_label', backend: fake, model: 'openai/gpt-4o-mini' })
    await assert.rejects(() => handle.prompt({ text: 'x' }), /provider down/)
    assert.equal(attempts, PI_FAILURE_RETRY + 1)
  })

  it('pi kernel: in-memory session, no codingTools (optional live prompt skipped)', async () => {
    const handle = openSession({
      role: 'hole_b_label',
      model: 'anthropic/claude-opus-4-5',
      backend: new PiSessionBackend(),
    })
    try {
      await handle.attach()
      const names = await handle.activeToolNames()
      for (const banned of ['read', 'bash', 'edit', 'write']) {
        assert.equal(names.includes(banned), false, `coding tool ${banned} must stay off`)
      }
    } finally {
      handle.dispose()
    }
  })
})
