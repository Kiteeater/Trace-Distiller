import { dirname, join } from 'node:path'
import { BENCHMARK_PASS } from '../constant/compression.ts'
import {
  coherencePass,
  compressionScore,
  keyStepRecall,
  m1Score,
  type BenchmarkParts,
} from './metrics.ts'

/** 三档赛道。分开报表，禁止合成跨档平均分。 */
export const BENCHMARK_BINS = ['short', 'long', 'multi_dead_end'] as const
export type BenchmarkBin = (typeof BENCHMARK_BINS)[number]

export type MetricStatus = 'pass' | 'fail' | 'skipped'

export interface KeyDecisionsGold {
  trace_id: string
  segment_ids: string[]
}

export interface ScoreSampleInput {
  bin: BenchmarkBin
  trace_id: string
  compression_ratio: number
  distill_cost_ratio: number
  kept: readonly string[]
  /** null = 无独立金标（M1 skipped，不算硬挂）。禁止用流水线自己的标签当金标。 */
  gold_segment_ids: readonly string[] | null
  replay: number | null
  qa: number | null
  coherence_scores: readonly number[] | null
  /** L4 / coherence / verify 可观察失败说明（类似 hole_notes） */
  notes?: readonly string[]
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
  /** 任一项 fail → 0；有 skipped 且无 fail → null（M1 不硬挂）；六项全过 → 乘法分。含 cost。 */
  composite: number | null
  /**
   * M1 出门分：压缩率得分 × 关键步召回。只看 compress+recall；
   * cost/replay/qa/coherence 失败不拖垮 m1_score（仍会拖垮 composite）。
   */
  m1_score: number | null
  gold: 'independent' | 'skipped'
  notes?: string[]
}

export interface BinTable {
  bin: BenchmarkBin
  n: number
  mean_composite: number | null
  stddev_composite: number | null
  mean_m1_score: number | null
  stddev_m1_score: number | null
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
  const row = parsed as { trace_id?: unknown; segment_ids?: unknown }
  if (typeof row.trace_id !== 'string' || row.trace_id.length === 0) {
    throw new Error('key-decisions.json 需要 trace_id')
  }
  if (!Array.isArray(row.segment_ids) || row.segment_ids.some((id) => typeof id !== 'string')) {
    throw new Error('key-decisions.json 需要 string[] segment_ids')
  }
  return { trace_id: row.trace_id, segment_ids: row.segment_ids }
}

/**
 * 六项门槛：缺项 skipped（M1 不硬挂）；任一项 fail → 总分 0。
 * 全过：Score = 压缩率得分 × 召回 × 重放（召回/重放 0–1）。
 * 完整 composite 含 cost 门槛；勿静默去掉。
 */
export function scoredComposite(parts: BenchmarkParts): number | null {
  const statuses = metricStatuses(parts)
  if (Object.values(statuses).some((s) => s === 'fail')) return 0
  if (Object.values(statuses).some((s) => s === 'skipped')) return null
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
    distill_cost_ratio:
      Number.isFinite(parts.distill_cost_ratio) &&
      parts.distill_cost_ratio <= BENCHMARK_PASS.distill_cost_ratio_max
        ? 'pass'
        : 'fail',
  }
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
  }
  if (input.notes !== undefined && input.notes.length > 0) {
    sample.notes = [...input.notes]
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
    const m1Scores = table.samples
      .map((s) => s.m1_score)
      .filter((n): n is number => n !== null)
    const m1Stats = meanStd(m1Scores)
    table.mean_m1_score = m1Stats.mean
    table.stddev_m1_score = m1Stats.stddev
  }
  return { bins }
}

function emptyBin(bin: BenchmarkBin): BinTable {
  return {
    bin,
    n: 0,
    mean_composite: null,
    stddev_composite: null,
    mean_m1_score: null,
    stddev_m1_score: null,
    samples: [],
  }
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
