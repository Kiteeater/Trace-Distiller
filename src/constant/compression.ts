import type { CutProfile } from '../types/cut_profile.ts'
import { SPAN_MAX_GAP_SEGMENTS } from './window.ts'

/** 压缩率：剪后 RawTrace 原文 token / 原 token。PRD MVP 目标。 */
export const COMPRESSION_RATIO_TARGET = { min: 0.1, max: 0.3 }

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
