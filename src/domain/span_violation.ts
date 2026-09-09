export const SPAN_VIOLATION_REASONS = ['gap_too_large', 'continuity_fail'] as const

export type SpanViolationReason = (typeof SPAN_VIOLATION_REASONS)[number]

export interface SpanViolation {
  id: string
  left_segment_id: string
  right_segment_id: string
  gap_segments: number
  reason: SpanViolationReason
  /** 洞 B check_continuity 的分数，若请过。 */
  continuity_score?: number
}
