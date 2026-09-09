export const AgentRole = {
  HoleASkeleton: 'hole_a_skeleton',
  HoleBLabel: 'hole_b_label',
  L4Qa: 'l4_qa',
  L4Replay: 'l4_replay',
  L4Review: 'l4_review',
} as const

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole]
