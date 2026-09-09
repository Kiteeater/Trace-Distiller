import type { RawTurn, TraceId } from './raw_trace'
import type { SegmentCard } from './segment'

export interface CutPlan {
  trace_id: TraceId
  profile_id: string
  warrant_ref: string
  kept: string[]
  collapsed: Array<{ segment_id: string; summary: string }>
  dropped: string[]
  span_ok: boolean
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
  collapsed: Array<{ segment_id: string; summary: string }>
}
