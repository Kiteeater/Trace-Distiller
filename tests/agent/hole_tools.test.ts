import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HOLE_TOOL_NAMES } from '../../src/agent/extension.ts'
import {
  buildHoleCustomTools,
  L4_REPLAY_CODING_TOOLS,
  resolvePiToolRegistration,
} from '../../src/agent/sessions/hole_tools.ts'

describe('hole custom tools registration', () => {
  it('builds the closed-set cut-brain / hole tools', () => {
    const tools = buildHoleCustomTools(HOLE_TOOL_NAMES)
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['apply_rules_hint', 'check_continuity', 'keep_segment', 'label_segment', 'read_segment'],
    )
  })

  it('maps empty tools to noTools=all', () => {
    const reg = resolvePiToolRegistration([])
    assert.deepEqual(reg, { tools: [], noTools: 'all' })
  })

  it('maps hole tool names to customTools + noTools=builtin', () => {
    const reg = resolvePiToolRegistration(HOLE_TOOL_NAMES)
    assert.equal(reg.noTools, 'builtin')
    assert.deepEqual(reg.tools.sort(), [
      'apply_rules_hint',
      'check_continuity',
      'keep_segment',
      'label_segment',
      'read_segment',
    ])
    assert.equal(reg.customTools?.length, 5)
  })

  it('ignores unknown tool names so coding tools stay out', () => {
    const reg = resolvePiToolRegistration(['label_segment', 'bash', 'read'])
    assert.deepEqual(reg.tools, ['label_segment'])
    assert.equal(reg.customTools?.length, 1)
    assert.equal(reg.noTools, 'builtin')
  })
  it('maps pure coding allowlist without noTools (L4 replay)', () => {
    const reg = resolvePiToolRegistration(L4_REPLAY_CODING_TOOLS)
    assert.deepEqual(reg.tools, [...L4_REPLAY_CODING_TOOLS])
    assert.equal(reg.noTools, undefined)
    assert.equal(reg.customTools, undefined)
  })

})
