export const CutAction = {
  Keep: 'keep',
  Collapse: 'collapse',
  Drop: 'drop',
} as const

export type CutAction = (typeof CutAction)[keyof typeof CutAction]
