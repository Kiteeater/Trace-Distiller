import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FakeSessionBackend,
  mapPiSessionEventToThin,
  openSession,
  setThinSessionEventSink,
  wrapRetry,
} from '../../src/agent/sessions/open_session.ts'
import {
  assertThinSessionEvent,
  thinEventHasForbiddenPayload,
  type ThinSessionEvent,
} from '../../src/types/thin_session_event.ts'

const here = dirname(fileURLToPath(import.meta.url))
const sessionsDir = join(here, '../../src/agent/sessions')

const SECRET_ARG = 'SECRET_TOOL_ARG_DO_NOT_LEAK'
const EVIDENCE_BODY = 'EVIDENCE_SEGMENT_BODY_MUST_NOT_APPEAR'

afterEach(() => {
  setThinSessionEventSink(undefined)
})

function fakeWithSecrets(): FakeSessionBackend {
  return new FakeSessionBackend((_input, opts) => ({
    text: 'ok',
    json: null,
    tool_calls: [
      {
        name: 'read_segment',
        arguments: { secret: SECRET_ARG, evidence: EVIDENCE_BODY, body: EVIDENCE_BODY },
      },
      {
        name: 'label_segment',
        arguments: { segment_id: 's0001', label: 'key_decision', evidence: EVIDENCE_BODY },
      },
    ],
    usage: { role: opts.role, input_tokens: 11, output_tokens: 7 },
  }))
}

function assertThinBatch(events: ThinSessionEvent[]): void {
  assert.ok(events.length > 0)
  for (const event of events) {
    assertThinSessionEvent(event)
    assert.equal(thinEventHasForbiddenPayload(event), false)
    assert.ok(!('args' in event))
    assert.ok(!('result' in event))
    assert.ok(!('content' in event))
    assert.ok(!('messages' in event))
    assert.ok(!('text' in event))
    assert.ok(!('evidence' in event))
    assert.ok(!('tool_calls' in event))
    assert.ok(!('partialResult' in event))
  }
  const blob = JSON.stringify(events)
  assert.equal(blob.includes(SECRET_ARG), false)
  assert.equal(blob.includes(EVIDENCE_BODY), false)
}

describe('thin session events (Fake)', () => {
  it('onThinEvent / subscribeThinEvents / module sink emit role, round, tool names, usage deltas', async () => {
    const fromOpts: ThinSessionEvent[] = []
    const fromSub: ThinSessionEvent[] = []
    const fromSink: ThinSessionEvent[] = []
    setThinSessionEventSink((e) => fromSink.push(e))
    const fake = fakeWithSecrets()
    const handle = openSession({
      role: 'hole_b_label',
      backend: fake,
      onThinEvent: (e) => fromOpts.push(e),
    })
    const unsub = handle.subscribeThinEvents((e) => fromSub.push(e))
    const result = await handle.prompt({ text: 'label this' })
    assert.equal(result.tool_calls[0]?.arguments && typeof result.tool_calls[0].arguments === 'object', true)

    assert.deepEqual(fromOpts, fromSub)
    assert.deepEqual(fromOpts, fromSink)
    assertThinBatch(fromOpts)

    const kinds = fromOpts.map((e) => e.kind)
    assert.deepEqual(kinds, [
      'turn_start',
      'tool_start',
      'tool_end',
      'tool_start',
      'tool_end',
      'usage',
      'turn_end',
    ])
    assert.equal(fromOpts[0]?.role, 'hole_b_label')
    assert.equal(fromOpts[0]?.round, 1)
    assert.equal(fromOpts[1]?.tool_name, 'read_segment')
    assert.equal(fromOpts[3]?.tool_name, 'label_segment')
    const usage = fromOpts.find((e) => e.kind === 'usage')
    assert.equal(usage?.input_tokens_delta, 11)
    assert.equal(usage?.output_tokens_delta, 7)

    unsub()
    await handle.prompt({ text: 'second' })
    assert.equal(fromSub.filter((e) => e.round === 2).length, 0)
    assert.ok(fromOpts.some((e) => e.round === 2))
    handle.dispose()
  })

  it('setThinSessionEventSink(undefined) is a no-op (prompts emit nothing to the sink)', async () => {
    const sink: ThinSessionEvent[] = []
    setThinSessionEventSink((e) => sink.push(e))
    setThinSessionEventSink(undefined)
    const handle = openSession({ role: 'l4_qa', backend: fakeWithSecrets() })
    await handle.prompt({ text: 'qa' })
    assert.deepEqual(sink, [])
    handle.dispose()
  })

  it('wrapRetry forwards subscribeThinEvents', async () => {
    const fake = fakeWithSecrets()
    const inner = fake.open({ role: 'l4_qa', model: 'unspecified:l4_qa', tools: [] })
    const wrapped = wrapRetry(inner)
    const got: ThinSessionEvent[] = []
    wrapped.subscribeThinEvents((e) => got.push(e))
    await wrapped.prompt({ text: 'x' })
    assertThinBatch(got)
    wrapped.dispose()
  })

  it('mapPiSessionEventToThin strips args/result/partialResult/messages and ignores bodies', () => {
    const start = mapPiSessionEventToThin(
      {
        type: 'tool_execution_start',
        toolName: 'read_segment',
        args: { secret: SECRET_ARG },
      },
      { role: 'hole_a_skeleton', round: 1 },
    )
    assert.deepEqual(start, { role: 'hole_a_skeleton', round: 1, kind: 'tool_start', tool_name: 'read_segment' })
    assertThinSessionEvent(start)
    assert.equal(thinEventHasForbiddenPayload(start), false)

    const end = mapPiSessionEventToThin(
      {
        type: 'tool_execution_end',
        toolName: 'read_segment',
        result: { content: EVIDENCE_BODY },
        isError: true,
      },
      { role: 'hole_a_skeleton', round: 1 },
    )
    assert.deepEqual(end, {
      role: 'hole_a_skeleton',
      round: 1,
      kind: 'tool_end',
      tool_name: 'read_segment',
      is_error: true,
    })
    assertThinSessionEvent(end)

    const usage = mapPiSessionEventToThin(
      {
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 4, output: 2 }, content: EVIDENCE_BODY },
      },
      { role: 'hole_a_skeleton', round: 2 },
    )
    assert.deepEqual(usage, {
      role: 'hole_a_skeleton',
      round: 2,
      kind: 'usage',
      input_tokens_delta: 4,
      output_tokens_delta: 2,
    })
    assert.equal(JSON.stringify(usage).includes(EVIDENCE_BODY), false)

    assert.equal(mapPiSessionEventToThin({ type: 'message_update', message: { text: EVIDENCE_BODY } }, { role: 'l4_qa', round: 1 }), undefined)
    assert.equal(mapPiSessionEventToThin({ type: 'agent_end', messages: [{ content: SECRET_ARG }] }, { role: 'l4_qa', round: 1 }), undefined)
    assert.equal(mapPiSessionEventToThin({ type: 'queue_update', steering: [SECRET_ARG] }, { role: 'l4_qa', round: 1 }), undefined)
    assert.equal(mapPiSessionEventToThin({ type: 'compaction_start' }, { role: 'l4_qa', round: 1 }), undefined)
  })

  it('sessions/ must not import service/', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const st = statSync(path)
        if (st.isDirectory()) walk(path)
        else if (name.endsWith('.ts')) files.push(path)
      }
    }
    walk(sessionsDir)
    for (const path of files) {
      const src = readFileSync(path, 'utf8')
      assert.doesNotMatch(src, /from ['"][^'"]*service\//)
    }
  })
})
