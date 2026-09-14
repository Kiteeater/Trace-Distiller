export const AGENT_ROLES = [
  'hole_a_skeleton',
  'hole_b_label',
  'l4_qa',
  'l4_replay',
  'l4_review',
] as const

/** 预算科目，不是「系统里有五个 agent」。编排器不是一个 role。 */
export type AgentRole = (typeof AGENT_ROLES)[number]

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)
}
