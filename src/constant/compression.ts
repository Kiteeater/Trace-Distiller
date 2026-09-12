import type { CutProfile } from '../types/cut_profile.ts'
import { SPAN_MAX_GAP_SEGMENTS } from './window.ts'

/** Long valve: allow wider keep gaps so span repair does not re-inflate MIMO exploration. */
export const LONG_SPAN_MAX_GAP_SEGMENTS = 12

/** 压缩率：剪后 RawTrace 原文 token / 原 token。PRD MVP 目标。 */
export const COMPRESSION_RATIO_TARGET = { min: 0.1, max: 0.3 }

/**
 * 压缩率得分分段结点（ADR-0005）。ratio = 剪后/原。
 * 不奖励剪到 0%。中间线性插值。
 */
export const COMPRESSION_SCORE_KNOTS: readonly { ratio: number; score: number }[] = [
  { ratio: 0, score: 0 },
  { ratio: 0.05, score: 100 },
  { ratio: 0.15, score: 90 },
  { ratio: 0.3, score: 60 },
  { ratio: 1, score: 0 },
]

/** 六项及格线（ADR-0005 / benchmark）。未跑的项不算及格。 */
export const BENCHMARK_PASS = {
  compression_ratio_max: 0.3,
  key_step_recall_min: 0.95,
  replay_min: 0.9,
  qa_min: 0.85,
  coherence_mean_min: 4,
  coherence_item_min: 2,
  distill_cost_ratio_max: 0.3,
} as const

/**
 * Short / small traces: hole A+B fixed overhead (~6–10k) makes distill_cost_ratio>0.3
 * almost always. Cost is still **reported**; composite must not fail on this gate.
 * Long traces with original_tokens above this still use distill_cost_ratio_max.
 * Cost still excludes L4 (ADR-0007).
 */
export const COST_SOFT_ORIGINAL_TOKENS = 25_000

/**
 * Prefer not crushing keep below this ratio (cut_tokens/original).
 * Target band ~8–15% for long/multi coherence; short also must not over-cut.
 * Soft floor — preserve gold / key skeleton first via blind-review fill-in.
 */
export const KEEP_RATIO_FLOOR = 0.08

/** Only enforce keep floor on mid/long traces; short uneven segments can jump past 0.3. */
export const KEEP_FLOOR_MIN_ORIGINAL_TOKENS = 5_000

/** Prefer not promoting keep past this when lifting off the floor (~8–15% band). */
export const KEEP_RATIO_SOFT_CAP = 0.15


/**
 * ADR-0015 direction: rules as the default cheap knife should cover ~70% of
 * segments before expensive Hole A/B. Not a pipeline gate in this PR (follow-up).
 * Agent still decides hard cases (ADR-0010); this is not a resurrected `--no-llm` path.
 * Complement of LLM_LABEL_FRACTION_HINT (kept as a 0.3 literal to avoid 1-0.7 float noise).
 */
export const RULES_FIRST_COVERAGE_TARGET = 0.7

/** 规则层清完后，预期仍要进洞 B 的段比例（成本粗账，不是硬门禁）。 */
export const LLM_LABEL_FRACTION_HINT = 0.3

export const DEFAULT_PROFILE_ID = 'default'

/** 代表性死胡同最多留几条。已拍板：3（default / multi）。 */
export const DEAD_END_MAX_REPRESENTATIVE = 3

/** Short valve: less aggressive dead_end collapse (keep more reps visible). */
export const SHORT_DEAD_END_MAX_REPRESENTATIVE = 5

/** Long valve: stronger dead_end collapse. */
export const LONG_DEAD_END_MAX_REPRESENTATIVE = 2

/** 死胡同一句话摘要最大字符数。已拍板：80。 */
export const DEAD_END_SUMMARY_MAX_CHARS = 80

/** Short valve: default window (less aggressive than long's smaller windows). */
export const SHORT_LABEL_WINDOW_SIZE = 8

/** Long / multi valve: smaller window → more aggressive labeling. */
export const LONG_LABEL_WINDOW_SIZE = 6

function sharedLabels(): Pick<CutProfile, 'keep_labels' | 'collapse_labels' | 'drop_labels' | 'compression_ratio'> {
  return {
    keep_labels: ['key_decision', 'useful_exploration'],
    collapse_labels: ['dead_end', 'collapse_uncertain'],
    drop_labels: ['routine'],
    compression_ratio: { ...COMPRESSION_RATIO_TARGET },
  }
}

export const DEFAULT_CUT_PROFILE: CutProfile = {
  id: DEFAULT_PROFILE_ID,
  ...sharedLabels(),
  span: {
    max_gap_segments: SPAN_MAX_GAP_SEGMENTS,
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: DEAD_END_MAX_REPRESENTATIVE,
    summary_max_chars: DEAD_END_SUMMARY_MAX_CHARS,
  },
}

/**
 * Short-bin CutProfile: soft cost (via costGateApplies), less aggressive cut —
 * more dead_end representatives kept as collapse, larger label window, no keep floor.
 */
export const SHORT_CUT_PROFILE: CutProfile = {
  id: 'bin:short',
  ...sharedLabels(),
  span: {
    max_gap_segments: SPAN_MAX_GAP_SEGMENTS,
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: SHORT_DEAD_END_MAX_REPRESENTATIVE,
    summary_max_chars: DEAD_END_SUMMARY_MAX_CHARS,
  },
  label_window_size: SHORT_LABEL_WINDOW_SIZE,
  keep_ratio_floor: null,
}

/**
 * Long-bin CutProfile: stronger dead_end collapse, aggressive hole windows,
 * keep floor ~8–15%.
 */
export const LONG_CUT_PROFILE: CutProfile = {
  id: 'bin:long',
  ...sharedLabels(),
  span: {
    max_gap_segments: LONG_SPAN_MAX_GAP_SEGMENTS,
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: LONG_DEAD_END_MAX_REPRESENTATIVE,
    summary_max_chars: DEAD_END_SUMMARY_MAX_CHARS,
  },
  label_window_size: LONG_LABEL_WINDOW_SIZE,
  keep_ratio_floor: KEEP_RATIO_FLOOR,
}

/**
 * Multi-dead-end bin: strong collapse but retain up to DEAD_END_MAX_REPRESENTATIVE
 * reps (track needs visible retries); same keep floor / window as long.
 */
export const MULTI_DEAD_END_CUT_PROFILE: CutProfile = {
  id: 'bin:multi_dead_end',
  ...sharedLabels(),
  span: {
    max_gap_segments: LONG_SPAN_MAX_GAP_SEGMENTS,
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: DEAD_END_MAX_REPRESENTATIVE,
    summary_max_chars: DEAD_END_SUMMARY_MAX_CHARS,
  },
  label_window_size: LONG_LABEL_WINDOW_SIZE,
  keep_ratio_floor: KEEP_RATIO_FLOOR,
}

export type ProfileBin = 'short' | 'long' | 'multi_dead_end'

/** Bin-aware CutProfile defaults (the short/long valve). */
export function cutProfileForBin(bin: ProfileBin): CutProfile {
  switch (bin) {
    case 'short':
      return SHORT_CUT_PROFILE
    case 'long':
      return LONG_CUT_PROFILE
    case 'multi_dead_end':
      return MULTI_DEAD_END_CUT_PROFILE
  }
}
