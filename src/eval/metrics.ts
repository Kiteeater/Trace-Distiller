export interface CompressionInput {
  original_tokens: number
  cut_tokens: number
}

export interface CostInput {
  /** 仅 hole_a_* + hole_b_*。禁止把 L4（qa / replay / review）计入。 */
  hole_a_plus_b_tokens: number
  tokens_removed: number
}

/** 剪后 / 原。original_tokens <= 0 时返回 0，不假装已有官方口径。 */
export function compressionRatio(input: CompressionInput): number {
  if (input.original_tokens <= 0) return 0
  return input.cut_tokens / input.original_tokens
}

/**
 * 剪辑消耗 ÷ 剪掉的 token。L4 token 不计蒸馏成本。
 * tokens_removed <= 0：消耗为 0 则 0，否则 +Infinity。
 */
export function distillCostRatio(input: CostInput): number {
  if (input.tokens_removed <= 0) {
    return input.hole_a_plus_b_tokens === 0 ? 0 : Number.POSITIVE_INFINITY
  }
  return input.hole_a_plus_b_tokens / input.tokens_removed
}
