import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SKILL_ROUTE } from '../../src/constant/skill_route.ts'
import { SCENARIOS } from '../../src/enums/scenario.ts'

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/agent/skills')
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('agent/skills', () => {
  it('has five scenario files matching SKILL_ROUTE plus README', () => {
    const names = readdirSync(skillsDir).sort()
    assert.deepEqual(names, [
      'README.md',
      'debug.md',
      'implement.md',
      'investigate.md',
      'refactor.md',
      'test_fix.md',
    ])

    for (const scenario of SCENARIOS) {
      const rel = SKILL_ROUTE[scenario]
      assert.equal(rel, `agent/skills/${scenario}.md`)
      const text = readFileSync(join(repoRoot, 'src', rel), 'utf8')
      assert.match(text, /label_segment/)
      assert.match(text, /read_segment/)
      assert.match(text, /check_continuity/)
      assert.match(text, /禁止执行类工具/)
    }
  })
})
