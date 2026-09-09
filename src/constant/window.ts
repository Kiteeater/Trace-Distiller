export const FAIL_CLOSED_KEEP = true

export const REVIEW_MAX_ROUNDS = 2

export const SKELETON_PASS_TOKEN_HINT = 2000

export const LLM_LABEL_FRACTION_HINT = 0.3

/**
 * OPEN: LABEL_WINDOW_SIZE, span max_gap_segments, dead-end N, Jaccard
 * threshold are not locked (docs/modules/constant.md §6).
 */
export type LabelWindowSize = number
