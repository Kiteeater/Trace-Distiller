import type { Label } from '../enums/label'

export interface SpanPolicy {
  /** OPEN: numeric threshold not locked. */
  max_gap_segments: number
  fill_with_representative_dead_end: boolean
}

export interface DeadEndPolicy {
  /** OPEN: numeric thresholds not locked. */
  max_representative: number
  summary_max_chars: number
}

export interface CutProfile {
  id: string
  keep_labels: Label[]
  collapse_labels: Label[]
  drop_labels: Label[]
  compression_ratio: { min: number; max: number }
  span: SpanPolicy
  dead_end: DeadEndPolicy
}
