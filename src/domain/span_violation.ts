import type { SpanPolicy } from '../types/cut_profile'

export type SpanViolationReason = 'gap_too_large' | 'continuity_fail'

export interface SpanViolation {
  id: string
  left_segment_id: string
  right_segment_id: string
  gap_segments: number
  reason: SpanViolationReason
  continuity_score?: number
}

export function checkSpan(
  _keptIds: string[],
  _allIds: string[],
  _policy: SpanPolicy,
): SpanViolation[] {
  throw new Error('not implemented')
}
