export const FocusLevel = {
  Line: 'line',
  Card: 'card',
  Full: 'full',
} as const

export type FocusLevel = (typeof FocusLevel)[keyof typeof FocusLevel]
