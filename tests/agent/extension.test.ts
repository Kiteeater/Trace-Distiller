import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HOLE_FETCH_TOOL_NAMES,
  HOLE_JUDGMENT_TOOL_NAMES,
  HOLE_TOOL_NAMES,
  HOLE_TOOL_STATUS,
} from '../../src/agent/extension.ts'

const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/agent/extension.ts')

describe('extension hole tool names', () => {
  it('exports DRAFT closed set without handlers', () => {
    assert.equal(HOLE_TOOL_STATUS, 'DRAFT')
    assert.deepEqual([...HOLE_JUDGMENT_TOOL_NAMES], ['label_segment', 'check_continuity'])
    assert.deepEqual([...HOLE_FETCH_TOOL_NAMES], ['read_segment'])
    assert.deepEqual([...HOLE_TOOL_NAMES], [
      'label_segment',
      'check_continuity',
      'read_segment',
    ])

    const src = readFileSync(srcPath, 'utf8')
    assert.match(src, /稍后拍板|DRAFT/)
    assert.doesNotMatch(src, /export async function/)
    assert.doesNotMatch(src, /export function (label_segment|check_continuity|read_segment)/)
    assert.doesNotMatch(src, /^\s*import\s/m)
    assert.doesNotMatch(src, /createAgentSession/)
    assert.doesNotMatch(src, /@mariozechner\/pi/)
  })
})
