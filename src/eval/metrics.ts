import {
  BENCHMARK_PASS,
  COMPRESSION_SCORE_KNOTS,
  COST_SOFT_ORIGINAL_TOKENS,
} from '../constant/compression.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../domain/cut_decision.ts'
import type { Skeleton } from '../types/agent_view.ts'

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

/**
 * Cost gate for composite: short-bin / small original_tokens → reported but not failing.
 * L4 tokens never enter distill_cost_ratio (ADR-0007).
 */
export function costGateApplies(input: {
  bin?: string
  original_tokens?: number
}): boolean {
  if (input.bin === 'short') return false
  const n = input.original_tokens
  if (typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= COST_SOFT_ORIGINAL_TOKENS) {
    return false
  }
  return true
}

export function costGatePass(
  distill_cost_ratio: number,
  input: { bin?: string; original_tokens?: number } = {},
): boolean {
  if (!Number.isFinite(distill_cost_ratio)) return false
  if (!costGateApplies(input)) return true
  return distill_cost_ratio <= BENCHMARK_PASS.distill_cost_ratio_max
}

export interface QaScoreLike {
  answered: number
  correct: number
}

/**
 * QA：correct / answered。
 * answered=0（0/0）→ null（skipped，不记 fail）；有题未答对才是 0。
 */
export function qaRatio(score: QaScoreLike): number | null {
  if (score.answered <= 0) return null
  return score.correct / score.answered
}

/**
 * 关键步召回：金标段落在 kept 的比例。
 * 金标应来自旁路文件，禁止用 Distiller 自己的 LabelDecision。
 * 空金标返回 0，不假装召回 100%。
 */
export function keyStepRecall(input: {
  gold_segment_ids: readonly string[]
  kept: readonly string[]
}): number {
  if (input.gold_segment_ids.length === 0) return 0
  const kept = new Set(input.kept)
  let hit = 0
  for (const id of input.gold_segment_ids) {
    if (kept.has(id)) hit += 1
  }
  return hit / input.gold_segment_ids.length
}

/**
 * 洞 A 骨架节点段当弱代理金标。报告必须写明「非金标」。
 * 只取 turning_point / verification_anchor。
 */
export function skeletonWeakGoldIds(skeleton: Skeleton): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const node of skeleton.nodes) {
    if (node.kind !== 'turning_point' && node.kind !== 'verification_anchor') continue
    for (const id of node.segment_ids) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/** 连贯性：均分 ≥4.0 且任一项不得低于 2。空列表不及格。 */
export function coherencePass(scores: readonly number[]): boolean {
  if (scores.length === 0) return false
  const mean = scores.reduce((sum, n) => sum + n, 0) / scores.length
  const min = Math.min(...scores)
  return mean >= BENCHMARK_PASS.coherence_mean_min && min >= BENCHMARK_PASS.coherence_item_min
}

/** 压缩率得分分段映射（0–100），不奖励剪到 0%。 */
export function compressionScore(ratio: number): number {
  const knots = COMPRESSION_SCORE_KNOTS
  if (ratio <= knots[0]!.ratio) return knots[0]!.score
  for (let i = 1; i < knots.length; i += 1) {
    const right = knots[i]!
    if (ratio <= right.ratio) {
      const left = knots[i - 1]!
      return lerp(ratio, left.ratio, left.score, right.ratio, right.score)
    }
  }
  return knots[knots.length - 1]!.score
}

export interface BenchmarkParts {
  compression_ratio: number
  key_step_recall: number | null
  replay: number | null
  qa: number | null
  coherence_scores: readonly number[] | null
  distill_cost_ratio: number
  /** 用于 short/small soft cost gate；缺省按硬门槛。 */
  bin?: string
  original_tokens?: number
}

export function sixMetricsPresent(parts: BenchmarkParts): boolean {
  return (
    parts.key_step_recall !== null &&
    parts.replay !== null &&
    parts.qa !== null &&
    parts.coherence_scores !== null
  )
}

export function sixMetricsPassed(parts: BenchmarkParts): boolean {
  if (!sixMetricsPresent(parts)) return false
  return (
    parts.compression_ratio <= BENCHMARK_PASS.compression_ratio_max &&
    parts.key_step_recall! >= BENCHMARK_PASS.key_step_recall_min &&
    parts.replay! >= BENCHMARK_PASS.replay_min &&
    parts.qa! >= BENCHMARK_PASS.qa_min &&
    coherencePass(parts.coherence_scores!) &&
    costGatePass(parts.distill_cost_ratio, {
      ...(parts.bin !== undefined ? { bin: parts.bin } : {}),
      ...(parts.original_tokens !== undefined
        ? { original_tokens: parts.original_tokens }
        : {}),
    })
  )
}

/**
 * 六项全及格才计总分，否则 null（记分板 —，不硬写成 0；ADR-0014）。
 * 缺项（未跑 L4 / 无金标）同样 null，不假装 0 分样本。
 * Score = 压缩率得分 × 关键步召回 × 重放成功率（召回与重放用 0–1）。
 * 完整 composite 仍含 cost 等六项门槛；勿静默去掉 cost。
 */
export function compositeScore(parts: BenchmarkParts): number | null {
  if (!sixMetricsPassed(parts)) return null
  return compressionScore(parts.compression_ratio) * parts.key_step_recall! * parts.replay!
}

/**
 * M1 出门分：只强制压缩率 + 关键步召回（产品 MVP 硬指标）。
 * 不读 cost / replay / qa / coherence——那些仍只进完整 composite。
 * 仅当 compress 与 recall 门槛都过且 recall 有数值时才定义：
 * Score = compressionScore × key_step_recall（0–1）。
 * 任一门未过或缺召回 → null（记分板 —，不硬写成 0；ADR-0014）。
 */
export function m1Score(
  parts: Pick<BenchmarkParts, 'compression_ratio' | 'key_step_recall'>,
): number | null {
  if (parts.key_step_recall === null) return null
  const compressOk = parts.compression_ratio <= BENCHMARK_PASS.compression_ratio_max
  const recallOk = parts.key_step_recall >= BENCHMARK_PASS.key_step_recall_min
  if (!compressOk || !recallOk) return null
  return compressionScore(parts.compression_ratio) * parts.key_step_recall
}

function lerp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x1 === x0) return y0
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
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
