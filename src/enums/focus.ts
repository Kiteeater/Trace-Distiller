export const FOCUS_LEVELS = ['line', 'card', 'full'] as const

export type FocusLevel = (typeof FOCUS_LEVELS)[number]
