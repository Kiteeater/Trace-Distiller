import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACK_OR_MASKED_REQUIRED_MESSAGE,
  assertAckOrMaskedToolMessage,
  formatMaskedForPrompt,
  looksLikeRawToolPayload,
  maskToolResult,
  TOOL_MASK_DEFAULT_MAX_CHARS,
} from '../../src/agent/sessions/tool_mask.ts'
import {
  composeSessionPrompt,
  maskPromptMessageContent,
} from '../../src/agent/sessions/open_session.ts'
import { buildHoleCustomTools } from '../../src/agent/sessions/hole_tools.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('tool_mask', () => {
  it('truncates long strings and marks truncated', () => {
    const raw = 'x'.repeat(TOOL_MASK_DEFAULT_MAX_CHARS + 200)
    const masked = maskToolResult(raw)
    assert.equal(masked.truncated, true)
    assert.ok(masked.summary.length <= TOOL_MASK_DEFAULT_MAX_CHARS)
    assert.ok(masked.raw_byte_len > TOOL_MASK_DEFAULT_MAX_CHARS)
    assert.equal(masked.structure.kind, 'string')
  })

  it('masks read_segment full text to id + char count + head', () => {
    const body = 'LINE\n'.repeat(400)
    const masked = maskToolResult(
      { segment_id: 's0009', focus: 'full', text: body },
      { toolName: 'read_segment' },
    )
    assert.equal(masked.structure.kind, 'read_segment')
    assert.equal(masked.structure.segment_id, 's0009')
    assert.equal(masked.structure.text_chars, body.length)
    assert.ok(typeof masked.structure.head === 'string')
    assert.ok(!masked.summary.includes(body.slice(200, 400)))
    assert.equal(masked.truncated, true)
  })

  it('masks label_segment and check_continuity structurally', () => {
    const label = maskToolResult(
      { segment_id: 's0001', label: 'routine', confidence: 0.8 },
      { toolName: 'label_segment' },
    )
    assert.match(label.summary, /label_segment s0001=routine@0\.8/)
    assert.equal(label.truncated, false)

    const cont = maskToolResult(
      {
        left_id: 's0001',
        right_id: 's0002',
        reachable: true,
        score: 4,
        reason: 'r'.repeat(300),
      },
      { toolName: 'check_continuity' },
    )
    assert.match(cont.summary, /check_continuity s0001->s0002/)
    assert.equal(cont.truncated, true)
  })

  it('masks pi-style content blocks', () => {
    const masked = maskToolResult({
      content: [{ type: 'text', text: 'y'.repeat(600) }],
      details: { ok: true },
    })
    assert.equal(masked.truncated, true)
    assert.ok(masked.summary.length <= TOOL_MASK_DEFAULT_MAX_CHARS)
  })

  it('formatMaskedForPrompt returns summary only', () => {
    const masked = maskToolResult('hello')
    assert.equal(formatMaskedForPrompt(masked), 'hello')
  })

  it('maskPromptMessageContent leaves short content alone', () => {
    assert.equal(maskPromptMessageContent('short'), 'short')
  })

  it('maskPromptMessageContent masks short raw read_segment JSON (not length-only)', () => {
    const uniqueTail = 'UNIQUE_TAIL_MUST_NOT_LEAK'
    const text = `${'x'.repeat(130)}${uniqueTail}`
    const raw = JSON.stringify({
      segment_id: 's2',
      focus: 'full',
      text,
    })
    assert.ok(raw.length <= TOOL_MASK_DEFAULT_MAX_CHARS)
    assert.equal(looksLikeRawToolPayload(raw), true)
    const masked = maskPromptMessageContent(raw)
    assert.match(masked, /read_segment/)
    assert.doesNotMatch(masked, new RegExp(uniqueTail))
    assert.notEqual(masked, raw)
    const composed = composeSessionPrompt({
      text: 'next turn',
      messages: [{ role: 'user', content: raw }],
    })
    assert.doesNotMatch(composed, new RegExp(uniqueTail))
    assert.match(composed, /read_segment/)
  })

  it('assertAckOrMaskedToolMessage accepts ACK / masked summary; rejects raw tool body', () => {
    assert.doesNotThrow(() => assertAckOrMaskedToolMessage('ACK card_id=s2:s0001:structure'))
    assert.doesNotThrow(() => assertAckOrMaskedToolMessage('ACK apply_rules_hint resolved=2 unresolved=1'))
    assert.doesNotThrow(() =>
      assertAckOrMaskedToolMessage('read_segment s0009 text_chars=12 head="LINE"'),
    )
    const raw = JSON.stringify({
      segment_id: 's2',
      text: 'full body',
      focus: 'full',
    })
    assert.throws(
      () => assertAckOrMaskedToolMessage(raw),
      (err: unknown) =>
        err instanceof Error && err.message === ACK_OR_MASKED_REQUIRED_MESSAGE,
    )
    assert.throws(() => assertAckOrMaskedToolMessage('short human leak of a tool body {not json}'))
    const cutSrc = readFileSync(join(here, '../../src/agent/sessions/cut_brain.ts'), 'utf8')
    assert.match(cutSrc, /assertAckOrMaskedToolMessage/)
    const composeSrc = readFileSync(join(here, '../../src/agent/prompt/compose.ts'), 'utf8')
    assert.doesNotMatch(
      composeSrc,
      /export function maskPromptMessageContent\(content: string\): string \{\s*if \(content\.length <= 480\) return content/,
    )
    assert.match(composeSrc, /looksLikeRawToolPayload/)
  })

  it('hole tool execute returns masked ack (no full payload)', async () => {
    const tools = buildHoleCustomTools(['read_segment', 'label_segment'])
    const read = tools.find((t) => t.name === 'read_segment')
    const label = tools.find((t) => t.name === 'label_segment')
    assert.ok(read)
    assert.ok(label)
    // pi ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)
    const readOut = await read.execute(
      '1',
      { segment_id: 's0003' },
      new AbortController().signal,
      undefined,
      {} as never,
    )
    const labelOut = await label.execute(
      '2',
      { segment_id: 's0003', label: 'dead_end', confidence: 0.5 },
      new AbortController().signal,
      undefined,
      {} as never,
    )
    const readText = readOut.content
      .map((c) => ('text' in c ? String(c.text) : ''))
      .join('')
    const labelText = labelOut.content
      .map((c) => ('text' in c ? String(c.text) : ''))
      .join('')
    assert.match(readText, /read_segment/)
    assert.match(labelText, /label_segment s0003=dead_end/)
    const readDetails = readOut.details as { masked?: boolean }
    const labelDetails = labelOut.details as { masked?: boolean }
    assert.equal(readDetails.masked, true)
    assert.equal(labelDetails.masked, true)
  })

  it('masks keep_segment and apply_rules_hint without dumping ids dump as full payload', () => {
    const keep = maskToolResult(
      { kind: 'keep_segment', segment_id: 's0002', confidence: 0.95 },
      { toolName: 'keep_segment' },
    )
    assert.match(keep.summary, /keep_segment s0002/)
    assert.equal(keep.structure.kind, 'keep_segment')

    const hint = maskToolResult(
      {
        kind: 'apply_rules_hint',
        applied: true,
        resolved_count: 3,
        unresolved_ids: ['s0004', 's0005'],
        summary: 'x'.repeat(800),
      },
      { toolName: 'apply_rules_hint' },
    )
    assert.equal(hint.structure.kind, 'apply_rules_hint')
    assert.equal(hint.structure.resolved_count, 3)
    assert.ok(hint.summary.length <= TOOL_MASK_DEFAULT_MAX_CHARS)
    assert.match(hint.summary, /apply_rules_hint/)
  })

  it('composeSessionPrompt orders stable prefix before state pointers before unstable text', () => {
    const composed = composeSessionPrompt({
      system: 'SYS_STABLE',
      skill_text: 'SKILL_STABLE',
      skeleton_text: 'SKELETON_PTR',
      state_pointers: 'FOCUS_PTR',
      messages: [{ role: 'user', content: 'PRIOR_UNSTABLE' }],
      text: 'USER_UNSTABLE evidence=secret',
    })
    const sys = composed.indexOf('SYS_STABLE')
    const skill = composed.indexOf('SKILL_STABLE')
    const skel = composed.indexOf('SKELETON_PTR')
    const focus = composed.indexOf('FOCUS_PTR')
    const prior = composed.indexOf('PRIOR_UNSTABLE')
    const user = composed.indexOf('USER_UNSTABLE')
    assert.ok(sys >= 0 && skill > sys && skel > skill && focus > skel && prior > focus && user > prior)
    const stableEnd = composed.indexOf('SKELETON_PTR')
    assert.doesNotMatch(composed.slice(0, stableEnd), /USER_UNSTABLE|evidence=secret|PRIOR_UNSTABLE/)
  })

  it('prompt/compact.ts is a prompt-layer leaf (ADR-0016)', () => {
    const compactSrc = readFileSync(join(here, '../../src/agent/prompt/compact.ts'), 'utf8')
    assert.match(compactSrc, /export function prunePromptHistory/)
    const indexSrc = readFileSync(join(here, '../../src/agent/prompt/index.ts'), 'utf8')
    assert.match(indexSrc, /from ['"]\.\/compact\.ts['"]/)
  })
})

