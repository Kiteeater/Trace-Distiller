export const LABELS = [
  'key_decision',
  'useful_exploration',
  'dead_end',
  'routine',
] as const

export type Label = (typeof LABELS)[number]
