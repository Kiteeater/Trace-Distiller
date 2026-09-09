import { FAIL_CLOSED_KEEP_RULE } from '../domain/cut_decision.ts'

export interface CompressionInput {
  original_tokens: number
  cut_tokens: number
}

export interface CostInput {
  /** 仅 hole_a_* + hole_b_*。禁止把 L4（qa / replay / review）计入。 */
  hole_a_plus_b_tokens: number
  tokens_removed: number
}

/**
 * DistillResult 的结构子集。eval 不 import pipeline，避免 biz 反向依赖。
 * hole_a_plus_b_tokens 缺省按 0（无洞 / 未记用量）。
 */
export interface DistillMetricsSource {
  raw: { meta: { total_tokens: number } }
  training: { turns: ReadonlyArray<{ tokens: number }> }
  view: { segments: ReadonlyArray<unknown> }
  decisions: ReadonlyArray<{ source: { kind: string; name: string } }>
  warrant: { entries: ReadonlyArray<{ source: { name: string } }> }
  hole_a_plus_b_tokens?: number
}

export interface DistillMetrics {
  compression_ratio: number
  distill_cost_ratio: number
  /** 规则已定标段 / 总段。 */
  rule_coverage: number
  llm_segment_fraction: number
  fail_closed_count: number
  total_segments: number
  ruled_count: number
  llm_count: number
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

/** 从蒸馏结果汇总压缩率、规则覆盖、LLM 段占比、Fail-Closed 条数。 */
export function computeDistillMetrics(result: DistillMetricsSource): DistillMetrics {
  const original_tokens = result.raw.meta.total_tokens
  const cut_tokens = result.training.turns.reduce((sum, turn) => sum + turn.tokens, 0)
  const hole = result.hole_a_plus_b_tokens ?? 0
  const total_segments = result.view.segments.length
  const ruled_count = result.decisions.filter(
    (d) => d.source.kind === 'rule' && d.source.name !== FAIL_CLOSED_KEEP_RULE,
  ).length
  const llm_count = result.decisions.filter((d) => d.source.kind === 'llm').length
  const fail_closed_count = result.warrant.entries.filter(
    (e) => e.source.name === FAIL_CLOSED_KEEP_RULE,
  ).length
  return {
    compression_ratio: compressionRatio({ original_tokens, cut_tokens }),
    distill_cost_ratio: distillCostRatio({
      hole_a_plus_b_tokens: hole,
      tokens_removed: original_tokens - cut_tokens,
    }),
    rule_coverage: total_segments > 0 ? ruled_count / total_segments : 0,
    llm_segment_fraction: total_segments > 0 ? llm_count / total_segments : 0,
    fail_closed_count,
    total_segments,
    ruled_count,
    llm_count,
  }
}
