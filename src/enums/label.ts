export const Label = {
  KeyDecision: 'key_decision',
  UsefulExploration: 'useful_exploration',
  DeadEnd: 'dead_end',
  Routine: 'routine',
} as const

export type Label = (typeof Label)[keyof typeof Label]
