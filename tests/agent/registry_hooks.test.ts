import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACK_OR_MASKED_REQUIRED_MESSAGE, assertAckOrMaskedToolMessage } from '../../src/agent/prompt/tool_mask.ts'
import {
  ackHoleTool,
  defaultAfterDispatch,
  executeHoleTool,
  resetRegistryHooks,
  setRegistryHooks,
} from '../../src/agent/tools/registry.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

afterEach(() => {
  resetRegistryHooks()
})

describe('Distiller registry beforeDispatch / afterDispatch', () => {
  it('refuses unknown / forbidden hole tools before handlers (edit_trace, drop_segment, typo)', () => {
    for (const name of ['edit_trace', 'drop_segment', 'not_a_tool']) {
      const result = executeHoleTool(name, { segment_id: 's0001' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /unknown hole tool/)
    }
  })

  it('still refuses unknown tools when beforeDispatch is a no-op (closed-set guard remains)', () => {
    setRegistryHooks({
      beforeDispatch: () => undefined,
      afterDispatch: defaultAfterDispatch,
    })
    const result = executeHoleTool('edit_trace', { segment_id: 's0001' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /unknown hole tool/)
  })

  it('refuses out-of-slot label_segment when focusId is set (focus=1)', () => {
    const refused = executeHoleTool(
      'label_segment',
      { segment_id: 'other', label: 'routine', confidence: 0.4 },
      { focusId: 's0001' },
    )
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.match(refused.error, /focus=1/)

    const ok = executeHoleTool(
      'label_segment',
      { segment_id: 's0001', label: 'routine', confidence: 0.4 },
      { focusId: 's0001' },
    )
    assert.equal(ok.ok, true)
    if (ok.ok && ok.name === 'label_segment') assert.equal(ok.accepted.segment_id, 's0001')
  })

  it('refuses segment_id outside windowIds when context provides the window', () => {
    const refused = executeHoleTool(
      'keep_segment',
      { segment_id: 's0099', confidence: 0.9, keep_bits: ['skeleton_hit'] },
      { windowIds: new Set(['s0001']) },
    )
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.match(refused.error, /unknown segment_id/)
  })

  it('does not force check_continuity ids to equal focusId', () => {
    const result = executeHoleTool(
      'check_continuity',
      {
        left_id: 's0001',
        right_id: 's0002',
        reachable: true,
        score: 4,
        reason: 'next step',
      },
      { focusId: 's0001' },
    )
    assert.equal(result.ok, true)
  })

  it('ackHoleTool produces masked/ACK prompt text that passes assertAckOrMaskedToolMessage', () => {
    const ack = ackHoleTool('read_segment', {
      segment_id: 's1',
      kind: 'structure',
      card_id: 's2:s1:structure',
    })
    assert.equal(ack.details.masked, true)
    assert.equal(ack.content.length, 1)
    const text = ack.content[0]?.text
    assert.ok(typeof text === 'string')
    assert.doesNotThrow(() => assertAckOrMaskedToolMessage(text))
    assert.match(text, /^read_segment /)
  })

  it('defaultAfterDispatch throws ACK_OR_MASKED_REQUIRED on raw JSON tool bodies', () => {
    assert.throws(
      () =>
        defaultAfterDispatch({
          name: 'read_segment',
          args: {},
          ctx: {},
          promptText: '{"segment_id":"s1","text":"RAW_BODY_SECRET"}',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message, ACK_OR_MASKED_REQUIRED_MESSAGE)
        return true
      },
    )
  })

  it('resetRegistryHooks restores defaults: unknown tools refused and ack stays masked', () => {
    setRegistryHooks({})
    resetRegistryHooks()
    const unknown = executeHoleTool('drop_segment', { segment_id: 's0001' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.match(unknown.error, /unknown hole tool/)
    const ack = ackHoleTool('keep_segment', {
      segment_id: 's0001',
      confidence: 1,
      keep_bits: ['skeleton_hit'],
    })
    assert.doesNotThrow(() => assertAckOrMaskedToolMessage(ack.content[0]?.text ?? ''))
  })

  it('does not register pi Extension on() hooks or rewrite systemPrompt in tools/extension', () => {
    const files = [
      'src/agent/tools/registry.ts',
      'src/agent/tools/pi_tools.ts',
      'src/agent/extension.ts',
    ]
    for (const rel of files) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      assert.doesNotMatch(src, /\bapi\.on\s*\(/)
      assert.doesNotMatch(src, /\.on\s*\(\s*['"](?:before|after|session)/)
      assert.doesNotMatch(src, /systemPrompt\s*=/)
      assert.doesNotMatch(src, /system_prompt\s*=/)
    }
  })
})
