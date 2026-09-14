import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LoadSkillTextInput {
  skill_path: string
  skill_text?: string
}

/** Deterministic skill Markdown load. Model never picks files; orchestrator uses SKILL_ROUTE. */
export function loadSkillText(input: LoadSkillTextInput): string {
  if (input.skill_text !== undefined && input.skill_text.length > 0) return input.skill_text
  const base = input.skill_path.split(/[\\/]/).pop() ?? input.skill_path
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    input.skill_path,
    join(process.cwd(), input.skill_path),
    join(process.cwd(), 'src', input.skill_path),
    join(here, base),
  ]
  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8').trim()
      if (text.length > 0) return text
    } catch {
      continue
    }
  }
  throw new Error(`cannot load skill text from ${input.skill_path}`)
}

export function skillSourceName(skill_path: string): string {
  const base = skill_path.split(/[\\/]/).pop() ?? skill_path
  return base.replace(/\.md$/i, '')
}
