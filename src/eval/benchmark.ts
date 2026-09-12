import { dirname, join } from 'node:path'
import { isSpanFailure } from '../domain/span_violation.ts'
import { BENCHMARK_PASS } from '../constant/compression.ts'
import {
  coherencePass,
  compressionScore,
  costGateApplies,
  costGatePass,
  distillRoi,
  keyStepRecall,
  m1Score,
  sftTokensSaved,
  type BenchmarkParts,
} from './metrics.ts'
import type { HoleAVectorScore } from './vector_efficiency.ts'

/** 三档赛道。分开报表，禁止合成跨档平均分。 */
export const BENCHMARK_BINS = ['short', 'long', 'multi_dead_end'] as const
export type BenchmarkBin = (typeof BENCHMARK_BINS)[number]

export type MetricStatus = 'pass' | 'fail' | 'skipped'

export interface KeyDecisionsGold {
  trace_id: string
  segment_ids: string[]
  /** Optional gold intent for Hole A vector quality (ADR-0011 b). Not fed to Hole A. */
  intent_text?: string
  /** Optional gold skeleton point ids. Missing → skeleton recall skipped. */
  skeleton_segment_ids?: string[]
}

export interface ScoreSampleInput {
  bin: BenchmarkBin
  trace_id: string
  compression_ratio: number
  distill_cost_ratio: number
  /** RawTrace 原文 token；短样 / 小体积 soft cost gate 用。也用于 sft_saved。 */
  original_tokens?: number
  /**
   * Hole A+B tokens (L4 excluded). When omitted, scoreboard economics cells are null.
   */
  hole_a_plus_b_tokens?: number
  /** TrainingCut turn token sum. Used with original_tokens for sft_saved. */
  training_cut_tokens?: number
  /** Precomputed SFT tokens saved; wins over original−cut if both given. */
  sft_saved?: number
  kept: readonly string[]
  /** null = 无独立金标（M1 skipped，不算硬挂）。禁止用流水线自己的标签当金标。 */
  gold_segment_ids: readonly string[] | null
  replay: number | null
  qa: number | null
  coherence_scores: readonly number[] | null
  /** L4 / coherence / verify 可观察失败说明（类似 hole_notes） */
  notes?: readonly string[]
  /**
   * ADR-0011 (b) Hole A vector efficiency. Bench-only; not an m1/composite gate
   * and never an online stop signal.
   */
  hole_a_vector?: HoleAVectorScore | null
}

export interface MetricCell {
  value: number | null
  status: MetricStatus
}

export interface ScoredSample {
  trace_id: string
  bin: BenchmarkBin
  metrics: {
    compression_ratio: MetricCell
    key_step_recall: MetricCell
    replay: MetricCell
    qa: MetricCell
    coherence: MetricCell
    distill_cost_ratio: MetricCell
  }
  /**
   * 六项全过才定义（乘法分，含 cost）；任一门 fail 或 skipped → null（记分板 —，不硬写成 0；ADR-0014）。
   */
  composite: number | null
  /**
   * M1 出门分：压缩率得分 × 关键步召回。只看 compress+recall；
   * 两门都过才定义，否则 null（cost/replay/qa/coherence 失败不拖垮 m1_score）。
   */
  m1_score: number | null
  gold: 'independent' | 'skipped'
  notes?: string[]
  /** Bench-only Hole A vector efficiency (ADR-0011 b). Omitted when not computed. */
  hole_a_vector?: HoleAVectorScore | null
  /**
   * ADR-0015 economics. null when unknown (span / distill failure, or input omitted).
   * ROI is a column + mean of defined — not a composite/m1 gate.
   */
  distill_tokens: number | null
  sft_saved: number | null
  roi: number | null
}

export interface BinTable {
  bin: BenchmarkBin
  n: number
  mean_composite: number | null
  stddev_composite: number | null
  /** Samples whose composite is defined (all six gates passed). Mean is over these only. */
  n_defined_composite: number
  mean_m1_score: number | null
  stddev_m1_score: number | null
  /** Samples whose m1 is defined (compression + recall gates passed). */
  n_defined_m1: number
  /** Samples with any metric status `fail` (process-gate / distill / span). */
  n_gate_fail: number
  mean_hole_a_efficiency: number | null
  stddev_hole_a_efficiency: number | null
  /** Mean of finite defined ROI only (null/Infinity excluded). Not a composite gate. */
  mean_roi: number | null
  stddev_roi: number | null
  n_defined_roi: number
  samples: ScoredSample[]
}

/** 分档表。不要加 overall / combined 字段。 */
export interface BenchmarkReport {
  bins: {
    short: BinTable
    long: BinTable
    multi_dead_end: BinTable
  }
}

export function isBenchmarkBin(value: string): value is BenchmarkBin {
  return (BENCHMARK_BINS as readonly string[]).includes(value)
}

/** 金标路径候选：先 data/raw/<id>.key-decisions.json，再样本旁路。 */
export function keyDecisionFileCandidates(input: {
  trace_id: string
  cwd: string
  jsonl_path?: string
}): string[] {
  const safe = sanitizeTraceId(input.trace_id)
  const out = [
    join(input.cwd, 'data', 'raw', `${input.trace_id}.key-decisions.json`),
    join(input.cwd, 'data', 'raw', `${safe}.key-decisions.json`),
  ]
  if (input.jsonl_path !== undefined) {
    const stem = input.jsonl_path.replace(/\.jsonl$/u, '')
    out.push(`${stem}.key-decisions.json`)
    out.push(join(dirname(input.jsonl_path), `${safe}.key-decisions.json`))
  }
  return [...new Set(out)]
}

export function parseKeyDecisions(text: string): KeyDecisionsGold {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('key-decisions.json 必须是对象')
  }
  const row = parsed as { trace_id?: unknown; segment_ids?: unknown; intent_text?: unknown; intent?: unknown; skeleton_segment_ids?: unknown }
  if (typeof row.trace_id !== 'string' || row.trace_id.length === 0) {
    throw new Error('key-decisions.json 需要 trace_id')
  }
  if (!Array.isArray(row.segment_ids) || row.segment_ids.some((id) => typeof id !== 'string')) {
    throw new Error('key-decisions.json 需要 string[] segment_ids')
  }
  const gold: KeyDecisionsGold = { trace_id: row.trace_id, segment_ids: row.segment_ids }
  const intent_text = readOptionalIntentText(row.intent_text ?? row.intent)
  if (intent_text !== undefined) gold.intent_text = intent_text
  if (Array.isArray(row.skeleton_segment_ids)) {
    if (row.skeleton_segment_ids.some((id) => typeof id !== 'string')) {
      throw new Error('key-decisions.json skeleton_segment_ids 必须是 string[]')
    }
    gold.skeleton_segment_ids = row.skeleton_segment_ids
  }
  return gold
}

function readOptionalIntentText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim()
    return t.length > 0 ? t : undefined
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') {
      const t = text.trim()
      return t.length > 0 ? t : undefined
    }
  }
  return undefined
}

/**
 * 六项门槛：缺项 skipped；任一项 fail 或 skipped → 总分 null（记分板 —，ADR-0014）。
 * 全过：Score = 压缩率得分 × 召回 × 重放（召回/重放 0–1）。
 * 完整 composite 含 cost 门槛（short/small soft：只报不分）；勿静默去掉 L4 外成本。
 */
export function scoredComposite(parts: BenchmarkParts): number | null {
  const statuses = metricStatuses(parts)
  if (Object.values(statuses).some((s) => s !== 'pass')) return null
  return compressionScore(parts.compression_ratio) * parts.key_step_recall! * parts.replay!
}

/** M1：仅 compress + key_step_recall。见 metrics.m1Score。 */
export function scoredM1(parts: BenchmarkParts): number | null {
  return m1Score(parts)
}

export function metricStatuses(parts: BenchmarkParts): {
  compression_ratio: MetricStatus
  key_step_recall: MetricStatus
  replay: MetricStatus
  qa: MetricStatus
  coherence: MetricStatus
  distill_cost_ratio: MetricStatus
} {
  return {
    compression_ratio: parts.compression_ratio <= BENCHMARK_PASS.compression_ratio_max ? 'pass' : 'fail',
    key_step_recall: optionalGate(
      parts.key_step_recall,
      (v) => v >= BENCHMARK_PASS.key_step_recall_min,
    ),
    replay: optionalGate(parts.replay, (v) => v >= BENCHMARK_PASS.replay_min),
    qa: optionalGate(parts.qa, (v) => v >= BENCHMARK_PASS.qa_min),
    coherence:
      parts.coherence_scores === null
        ? 'skipped'
        : coherencePass(parts.coherence_scores)
          ? 'pass'
          : 'fail',
    distill_cost_ratio: (() => {
      if (!Number.isFinite(parts.distill_cost_ratio)) return 'fail'
      // short / small original: report value but do not fail composite
      const gateOpts = {
        ...(parts.bin !== undefined ? { bin: parts.bin } : {}),
        ...(parts.original_tokens !== undefined
          ? { original_tokens: parts.original_tokens }
          : {}),
      }
      if (!costGateApplies(gateOpts)) {
        return 'pass'
      }
      return costGatePass(parts.distill_cost_ratio, gateOpts)
        ? 'pass'
        : 'fail'
    })(),
  }
}

/** Bench sample that failed distill (e.g. SpanFailure): composite null, compression fail. Counts as n_gate_fail. */
export function failedBenchSample(input: {
  bin: BenchmarkBin
  trace_id: string
  notes: readonly string[]
}): ScoredSample {
  const sample: ScoredSample = {
    trace_id: input.trace_id,
    bin: input.bin,
    metrics: {
      compression_ratio: { value: null, status: 'fail' },
      key_step_recall: { value: null, status: 'skipped' },
      replay: { value: null, status: 'skipped' },
      qa: { value: null, status: 'skipped' },
      coherence: { value: null, status: 'skipped' },
      distill_cost_ratio: { value: null, status: 'skipped' },
    },
    composite: null,
    m1_score: null,
    gold: 'skipped',
    distill_tokens: null,
    sft_saved: null,
    roi: null,
  }
  if (input.notes.length > 0) sample.notes = [...input.notes]
  return sample
}

/** Stable note prefix for bench when distill throws. */
export function noteFromBenchDistillError(error: unknown): string {
  if (isSpanFailure(error)) {
    const detail =
      error.violations.length > 0
        ? error.violations
            .map(
              (v) =>
                `${v.reason}:${v.left_segment_id}->${v.right_segment_id}:gap=${String(v.gap_segments)}`,
            )
            .join(';')
        : error.message
    return `span_failure:${detail}`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `distill_error:${message}`
}

export function scoreSample(input: ScoreSampleInput): ScoredSample {
  const gold = input.gold_segment_ids
  const recall =
    gold === null
      ? null
      : keyStepRecall({ gold_segment_ids: gold, kept: input.kept })
  const parts: BenchmarkParts = {
    compression_ratio: input.compression_ratio,
    key_step_recall: recall,
    replay: input.replay,
    qa: input.qa,
    coherence_scores: input.coherence_scores,
    distill_cost_ratio: input.distill_cost_ratio,
    bin: input.bin,
    ...(input.original_tokens !== undefined
      ? { original_tokens: input.original_tokens }
      : {}),
  }
  const statuses = metricStatuses(parts)
  const coherenceValue =
    input.coherence_scores === null || input.coherence_scores.length === 0
      ? null
      : input.coherence_scores.reduce((sum, n) => sum + n, 0) / input.coherence_scores.length
  const sample: ScoredSample = {
    trace_id: input.trace_id,
    bin: input.bin,
    metrics: {
      compression_ratio: { value: input.compression_ratio, status: statuses.compression_ratio },
      key_step_recall: { value: recall, status: statuses.key_step_recall },
      replay: { value: input.replay, status: statuses.replay },
      qa: { value: input.qa, status: statuses.qa },
      coherence: { value: coherenceValue, status: statuses.coherence },
      distill_cost_ratio: {
        value: Number.isFinite(input.distill_cost_ratio) ? input.distill_cost_ratio : null,
        status: statuses.distill_cost_ratio,
      },
    },
    composite: scoredComposite(parts),
    m1_score: scoredM1(parts),
    gold: gold === null ? 'skipped' : 'independent',
    ...economicsFromScoreInput(input),
  }
  if (input.notes !== undefined && input.notes.length > 0) {
    sample.notes = [...input.notes]
  }
  if (input.hole_a_vector !== undefined) {
    sample.hole_a_vector = input.hole_a_vector
  }
  return sample
}

/** 按三档各自聚合。没有跨档平均分 API。 */
export function aggregateBins(samples: readonly ScoredSample[]): BenchmarkReport {
  const bins = {
    short: emptyBin('short'),
    long: emptyBin('long'),
    multi_dead_end: emptyBin('multi_dead_end'),
  }
  for (const sample of samples) {
    bins[sample.bin].samples.push(sample)
  }
  for (const bin of BENCHMARK_BINS) {
    const table = bins[bin]
    table.n = table.samples.length
    const scores = table.samples
      .map((s) => s.composite)
      .filter((n): n is number => n !== null)
    const stats = meanStd(scores)
    table.mean_composite = stats.mean
    table.stddev_composite = stats.stddev
    table.n_defined_composite = scores.length
    const m1Scores = table.samples
      .map((s) => s.m1_score)
      .filter((n): n is number => n !== null)
    const m1Stats = meanStd(m1Scores)
    table.mean_m1_score = m1Stats.mean
    table.stddev_m1_score = m1Stats.stddev
    table.n_defined_m1 = m1Scores.length
    table.n_gate_fail = table.samples.filter(sampleHasGateFail).length
    const holeAScores = table.samples
      .map((s) => s.hole_a_vector?.efficiency)
      .filter((n): n is number => n !== null && n !== undefined)
    const holeAStats = meanStd(holeAScores)
    table.mean_hole_a_efficiency = holeAStats.mean
    table.stddev_hole_a_efficiency = holeAStats.stddev
    const roiScores = table.samples
      .map((s) => s.roi)
      .filter((n): n is number => n !== null && Number.isFinite(n))
    const roiStats = meanStd(roiScores)
    table.mean_roi = roiStats.mean
    table.stddev_roi = roiStats.stddev
    table.n_defined_roi = roiScores.length
  }
  return { bins }
}

function emptyBin(bin: BenchmarkBin): BinTable {
  return {
    bin,
    n: 0,
    mean_composite: null,
    stddev_composite: null,
    n_defined_composite: 0,
    mean_m1_score: null,
    stddev_m1_score: null,
    n_defined_m1: 0,
    n_gate_fail: 0,
    mean_hole_a_efficiency: null,
    stddev_hole_a_efficiency: null,
    mean_roi: null,
    stddev_roi: null,
    n_defined_roi: 0,
    samples: [],
  }
}

function economicsFromScoreInput(input: ScoreSampleInput): {
  distill_tokens: number | null
  sft_saved: number | null
  roi: number | null
} {
  const distill_tokens =
    input.hole_a_plus_b_tokens !== undefined ? input.hole_a_plus_b_tokens : null
  let sft_saved: number | null = null
  if (input.sft_saved !== undefined) {
    sft_saved = Math.max(0, input.sft_saved)
  } else if (input.original_tokens !== undefined && input.training_cut_tokens !== undefined) {
    sft_saved = sftTokensSaved({
      original_tokens: input.original_tokens,
      training_cut_tokens: input.training_cut_tokens,
    })
  }
  const roi =
    distill_tokens !== null && sft_saved !== null
      ? distillRoi({ hole_a_plus_b_tokens: distill_tokens, sft_tokens_saved: sft_saved })
      : null
  return { distill_tokens, sft_saved, roi }
}

function sampleHasGateFail(sample: ScoredSample): boolean {
  return Object.values(sample.metrics).some((cell) => cell.status === 'fail')
}

function optionalGate(value: number | null, pass: (v: number) => boolean): MetricStatus {
  if (value === null) return 'skipped'
  return pass(value) ? 'pass' : 'fail'
}

function meanStd(values: readonly number[]): { mean: number | null; stddev: number | null } {
  if (values.length === 0) return { mean: null, stddev: null }
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length
  if (values.length === 1) return { mean, stddev: 0 }
  const variance = values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length
  return { mean, stddev: Math.sqrt(variance) }
}

function sanitizeTraceId(traceId: string): string {
  const cleaned = traceId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'trace'
}
