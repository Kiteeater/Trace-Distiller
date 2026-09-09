import type { CutProfile } from '../types/cut_profile.ts'
import { SPAN_MAX_GAP_SEGMENTS } from './window.ts'

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

/** 规则层清完后，预期仍要进洞 B 的段比例（成本粗账，不是硬门禁）。 */
export const LLM_LABEL_FRACTION_HINT = 0.3

export const DEFAULT_PROFILE_ID = 'default'

/** 代表性死胡同最多留几条。已拍板：3。 */
export const DEAD_END_MAX_REPRESENTATIVE = 3

/** 死胡同一句话摘要最大字符数。已拍板：80。 */
export const DEAD_END_SUMMARY_MAX_CHARS = 80

export const DEFAULT_CUT_PROFILE: CutProfile = {
  id: DEFAULT_PROFILE_ID,
  keep_labels: ['key_decision', 'useful_exploration'],
  collapse_labels: ['dead_end'],
  drop_labels: ['routine'],
  compression_ratio: COMPRESSION_RATIO_TARGET,
  span: {
    max_gap_segments: SPAN_MAX_GAP_SEGMENTS,
    fill_with_representative_dead_end: true,
  },
  dead_end: {
    max_representative: DEAD_END_MAX_REPRESENTATIVE,
    summary_max_chars: DEAD_END_SUMMARY_MAX_CHARS,
  },
}
