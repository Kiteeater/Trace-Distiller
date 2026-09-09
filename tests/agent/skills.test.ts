import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/agent/skills')

describe('agent/skills', () => {
  it('only has README while Scenario roster is OPEN', () => {
    const names = readdirSync(skillsDir)
    assert.deepEqual(names, ['README.md'])

    const text = readFileSync(join(skillsDir, 'README.md'), 'utf8')
    assert.match(text, /Scenario 名单未拍板/)
    assert.match(text, /冒充 M2/)
  })
})
