export const LABELS = [
  'key_decision',
  'useful_exploration',
  'dead_end',
  'routine',
  'collapse_uncertain',
] as const

export type Label = (typeof LABELS)[number]
