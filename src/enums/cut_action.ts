export const CUT_ACTIONS = ['keep', 'collapse', 'drop'] as const

export type CutAction = (typeof CUT_ACTIONS)[number]
