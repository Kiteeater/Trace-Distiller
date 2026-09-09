import type { FocusLevel } from '../enums/focus'

export type SegmentOutcome = 'ok' | 'error' | 'unknown'

export interface SegmentCard {
  id: string
  tool: string
  /** Homogeneous-action clustering key. Generation rule OPEN. */
  sig: string
  outcome: SegmentOutcome
  /** Representative segment id; null if this card is the representative. */
  rep_of: string | null
  reads: string[]
  writes: string[]
  tokens: number
  focus: FocusLevel
  /** First line/sentence clipped from raw text. Never LLM-written. */
  head: string
  raw_refs: string[]
}
