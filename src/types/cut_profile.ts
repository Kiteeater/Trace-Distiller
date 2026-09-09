export interface SpanPolicy {
  max_gap_segments: number
  fill_with_representative_dead_end: boolean
}

export interface DeadEndPolicy {
  max_representative: number
  summary_max_chars: number
}

export interface CutProfile {
  id: string
  keep_labels: string[]
  collapse_labels: string[]
  drop_labels: string[]
  compression_ratio: { min: number; max: number }
  span: SpanPolicy
  dead_end: DeadEndPolicy
}
