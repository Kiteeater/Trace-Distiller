import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterToolsOnly } from '../../src/pipeline/tools_only.ts'
import type { RawTurn, RawTurnRole } from '../../src/types/raw_trace.ts'
import { estimateTokens } from '../../src/utils/tokens.ts'

function makeTurn(
  id: string,
  role: RawTurnRole,
  content: string,
  tool?: { name: string; args: Record<string, unknown> },
): RawTurn {
  const turn: RawTurn = { id, role, content, tokens: estimateTokens(content) }
  if (tool !== undefined) {
    turn.tool = { name: tool.name, args_json: JSON.stringify(tool.args) }
  }
  return turn
}

describe('filterToolsOnly', () => {
  it('keeps first user, tool_call+tool_result, nearest thought; drops the rest; preserves order', () => {
    const turns: RawTurn[] = [
      makeTurn('u1', 'user', 'fix add so 1+1=2'),
      makeTurn('th-early', 'thought', 'planning the whole task'),
      makeTurn('asst-narrate', 'assistant', 'I will start by reading the file.'),
      makeTurn('th-read', 'thought', 'read add.ts'),
      makeTurn('call-read', 'tool_call', 'Read add.ts', { name: 'Read', args: { path: 'add.ts' } }),
      makeTurn('res-read', 'tool_result', 'export const add = (a, b) => a - b'),
      makeTurn('th-extra', 'thought', ' ramble after the read'),
      makeTurn('u2', 'user', 'also format the file'),
      makeTurn('asst-mid', 'assistant', 'editing now'),
      makeTurn('th-edit', 'thought', 'patch the minus'),
      makeTurn('call-edit', 'tool_call', 'Edit add.ts', { name: 'Edit', args: { path: 'add.ts' } }),
      makeTurn('res-edit', 'tool_result', 'ok'),
      makeTurn('th-tail', 'thought', 'done thinking'),
      makeTurn('asst-tail', 'assistant', 'Cleanup done.'),
    ]

    const originalIds = turns.map((t) => t.id)
    const originalRoles = turns.map((t) => t.role)
    const kept = filterToolsOnly(turns)

    assert.deepEqual(
      kept.map((t) => t.id),
      ['u1', 'th-read', 'call-read', 'res-read', 'th-edit', 'call-edit', 'res-edit'],
    )
    assert.deepEqual(
      kept.map((t) => t.role),
      ['user', 'thought', 'tool_call', 'tool_result', 'thought', 'tool_call', 'tool_result'],
    )

    assert.deepEqual(turns.map((t) => t.id), originalIds)
    assert.deepEqual(turns.map((t) => t.role), originalRoles)
    assert.equal(kept[0] === turns[0], false)
  })

  it('keeps only the nearest thought immediately before a tool_call', () => {
    const turns: RawTurn[] = [
      makeTurn('u1', 'user', 'task'),
      makeTurn('th1', 'thought', 'first thought'),
      makeTurn('th2', 'thought', 'second thought'),
      makeTurn('call', 'tool_call', 'Read', { name: 'Read', args: { path: 'a.ts' } }),
      makeTurn('res', 'tool_result', 'ok'),
    ]
    const kept = filterToolsOnly(turns)
    assert.deepEqual(
      kept.map((t) => t.id),
      ['u1', 'th2', 'call', 'res'],
    )
  })

  it('drops a thought when a non-thought sits between it and the tool_call', () => {
    const turns: RawTurn[] = [
      makeTurn('u1', 'user', 'task'),
      makeTurn('th', 'thought', 'I will call'),
      makeTurn('asst', 'assistant', 'narrating'),
      makeTurn('call', 'tool_call', 'Bash', { name: 'Bash', args: { command: 'ls' } }),
      makeTurn('res', 'tool_result', 'ok'),
    ]
    const kept = filterToolsOnly(turns)
    assert.deepEqual(
      kept.map((t) => t.id),
      ['u1', 'call', 'res'],
    )
  })

  it('attaches the prefix thought only to the first tool_call in a batch', () => {
    const turns: RawTurn[] = [
      makeTurn('u1', 'user', 'task'),
      makeTurn('th', 'thought', 'two calls'),
      makeTurn('call-a', 'tool_call', 'Read a', { name: 'Read', args: { path: 'a.ts' } }),
      makeTurn('call-b', 'tool_call', 'Read b', { name: 'Read', args: { path: 'b.ts' } }),
      makeTurn('res-a', 'tool_result', 'a'),
      makeTurn('res-b', 'tool_result', 'b'),
    ]
    const kept = filterToolsOnly(turns)
    assert.deepEqual(
      kept.map((t) => t.id),
      ['u1', 'th', 'call-a', 'call-b', 'res-a', 'res-b'],
    )
  })
})
