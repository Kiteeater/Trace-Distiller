import { isScenario, type Scenario } from '../enums/scenario.ts'

/**
 * 场景 → skill 文件。已拍板。
 * 键必须是 Scenario 五字面量；路径相对仓库，指向 `agent/skills/{name}.md`。
 * 查不到场景码回退 `implement`，禁止静默空 prompt。
 */
export const DEFAULT_SCENARIO: Scenario = 'implement'

export const SKILL_ROUTE: Record<Scenario, string> = {
  debug: 'agent/skills/debug.md',
  implement: 'agent/skills/implement.md',
  refactor: 'agent/skills/refactor.md',
  test_fix: 'agent/skills/test_fix.md',
  investigate: 'agent/skills/investigate.md',
}

export interface SkillRouteHit {
  scenario: Scenario
  path: string
  fallback: boolean
}

export function resolveSkillRoute(scenario: unknown): SkillRouteHit {
  if (isScenario(scenario)) {
    return { scenario, path: SKILL_ROUTE[scenario], fallback: false }
  }
  return {
    scenario: DEFAULT_SCENARIO,
    path: SKILL_ROUTE[DEFAULT_SCENARIO],
    fallback: true,
  }
}
