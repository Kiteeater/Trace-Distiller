import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadSkillText, skillSourceName } from '../../src/agent/skills/load.ts'
import { SKILL_ROUTE } from '../../src/constant/skill_route.ts'
import { SCENARIOS } from '../../src/enums/scenario.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('loadSkillText', () => {
  it('loads Markdown from SKILL_ROUTE paths', () => {
    for (const scenario of SCENARIOS) {
      const skill_path = SKILL_ROUTE[scenario]
      const text = loadSkillText({ skill_path })
      assert.ok(text.length > 0)
      assert.match(text, /label_segment/)
      const onDisk = readFileSync(join(repoRoot, 'src', skill_path), 'utf8').trim()
      assert.equal(text, onDisk)
    }
  })

  it('uses skill_text override when non-empty', () => {
    const override = 'OVERRIDE_SKILL_TEXT'
    const text = loadSkillText({
      skill_path: SKILL_ROUTE.implement,
      skill_text: override,
    })
    assert.equal(text, override)
  })

  it('throws when the path cannot be loaded', () => {
    assert.throws(
      () => loadSkillText({ skill_path: 'agent/skills/does-not-exist.md' }),
      /cannot load skill text/,
    )
  })

  it('throws on empty file instead of silent empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-skill-load-'))
    const skill_path = join(dir, 'empty-unique-skill.md')
    writeFileSync(skill_path, '   \n', 'utf8')
    assert.throws(() => loadSkillText({ skill_path }), /cannot load skill text/)
  })
})

describe('skillSourceName', () => {
  it('strips directory and .md suffix', () => {
    assert.equal(skillSourceName('agent/skills/debug.md'), 'debug')
    assert.equal(skillSourceName('src/agent/skills/test_fix.md'), 'test_fix')
    assert.equal(skillSourceName('implement.MD'), 'implement')
  })
})

describe('unified skill load wiring', () => {
  it('cut_brain and label_window have no local loadSkillText', () => {
    const sessions = join(repoRoot, 'src/agent/sessions')
    for (const name of ['cut_brain.ts', 'label_window.ts']) {
      const src = readFileSync(join(sessions, name), 'utf8')
      assert.doesNotMatch(src, /function loadSkillText/)
      assert.match(src, /from '\.\.\/skills\/load\.ts'/)
    }
  })

  it('open_session keeps noSkills: true', () => {
    const src = readFileSync(join(repoRoot, 'src/agent/sessions/open_session.ts'), 'utf8')
    assert.match(src, /noSkills:\s*true/)
  })
})
