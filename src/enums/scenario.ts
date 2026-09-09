/**
 * 洞 A 副产品场景码。已拍板五字面量。
 * 路由表见 `src/constant/skill_route.ts`；查不到回退 `implement`。
 */
export const SCENARIOS = [
  'debug',
  'implement',
  'refactor',
  'test_fix',
  'investigate',
] as const

export type Scenario = (typeof SCENARIOS)[number]

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value)
}
