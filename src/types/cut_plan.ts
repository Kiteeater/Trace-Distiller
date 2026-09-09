import type { RawTurn, TraceId } from './raw_trace.ts'
import type { SegmentCard } from './segment.ts'

export interface CollapsedSegment {
  segment_id: string
  summary: string
}

export interface CutPlan {
  trace_id: TraceId
  profile_id: string
  warrant_ref: string
  kept: string[]
  collapsed: CollapsedSegment[]
  dropped: string[]
  span_ok: boolean
  /** SpanViolation id，细节在 domain。 */
  span_violations: string[]
}

export interface TrainingCut {
  trace_id: TraceId
  plan_ref: string
  turns: RawTurn[]
}

export interface PlaybackCut {
  trace_id: TraceId
  plan_ref: string
  cards: SegmentCard[]
  collapsed: CollapsedSegment[]
}
