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
  /**
   * Bin valve: hole-B window size override.
   * short → larger (less aggressive); long/multi → smaller (more windows).
   * Omit → LABEL_WINDOW_SIZE default.
   */
  label_window_size?: number
  /**
   * Bin valve: soft keep floor (cut_tokens/original).
   * null = skip floor (short); number ≈ 0.08 for long/multi.
   * Omit → KEEP_RATIO_FLOOR with KEEP_FLOOR_MIN_ORIGINAL_TOKENS gate.
   */
  keep_ratio_floor?: number | null
}
