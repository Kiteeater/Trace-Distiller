import { dirname, join } from 'node:path'
import { isSpanFailure } from '../domain/span_violation.ts'
import { BENCHMARK_PASS } from '../constant/compression.ts'
import {
  compositeScore,
  distillRoi,
  fidelityScore,
  keyStepRecall,
  m1Score,
  sftTokensSaved,
  type BenchmarkParts,
  type ReplayFidelityKind,
} from './metrics.ts'
import type { HoleAVectorScore } from './vector_efficiency.ts'

/** 三档赛道。分开报表，禁止合成跨档平均分。 */
export const BENCHMARK_BINS = ['short', 'long', 'multi_dead_end'] as const
export type BenchmarkBin = (typeof BENCHMARK_BINS)[number]

/** `observed` is a reported number that is not a hard gate (ADR-0018). */
export type MetricStatus = 'pass' | 'fail' | 'skipped' | 'observed'

export interface KeyDecisionsGold {
  trace_id: string
  segment_ids: string[]
  /** Optional gold intent for Hole A vector quality (ADR-0011 b). Not fed to Hole A. */
  intent_text?: string
  /** Optional gold skeleton point ids. Missing → skeleton recall skipped. */
  skeleton_segment_ids?: string[]
  /**
   * ADR-0018: QA hard-gates only when the case set is marked solid.
   * Absent or false → QA is observational and does not enter fidelity.
   */
  qa_solid?: boolean
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
  /**
   * ADR-0018. Omitted → `absent` (the replay number does not enter fidelity).
   * Bench sets `fake` for `--fake-l4` and `real` only for `--with-l4` + verify.
   */
  replay_fidelity?: ReplayFidelityKind
  qa: number | null
  /** ADR-0018. True only when the case set is marked solid. */
  qa_solid?: boolean
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
  /**
   * Active rubric cells (ADR-0018). No compress column.
   * `replay`, `coherence`, and `distill_cost_ratio` are observational (`observed`
   * or `skipped`) — they do not fail the sample. `qa` fails only when `qa_solid`.
   */
  metrics: {
    key_step_recall: MetricCell
    replay: MetricCell
    qa: MetricCell
    coherence: MetricCell
    distill_cost_ratio: MetricCell
  }
  /**
   * Headline (ADR-0018). Defined only with gold and recall ≥ 0.95.
   * Real verified replay and solid QA may scale it. Fake replay does not.
   * Otherwise null (scoreboard —, not 0).
   */
  fidelity: number | null
  /** ADR-0018. Recorded so fake replay cannot be mistaken for a fidelity input. */
  replay_fidelity: ReplayFidelityKind
  /** ADR-0018. QA hard-gate applies only when true. */
  qa_solid: boolean
  /**
   * Distill / span failure. Counts toward `n_gate_fail`. Not a compress gate.
   */
  process_failed: boolean
  /**
   * @deprecated ADR-0018. Unchanged ADR-0005 formula (includes compress).
   * JSON migration field. Not the headline and not a scoreboard column.
   */
  composite: number | null
  /**
   * @deprecated ADR-0018. Unchanged formula: compressionScore × recall.
   * JSON migration field. Not the headline and not a scoreboard column.
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
  /** Headline mean over defined fidelity only (ADR-0018 / ADR-0014). */
  mean_fidelity: number | null
  stddev_fidelity: number | null
  /** Samples whose fidelity is defined (gold + recall gate). */
  n_defined_fidelity: number
  /**
   * @deprecated ADR-0018. Mean of defined composite (old six-gate formula).
   * Not the headline.
   */
  mean_composite: number | null
  stddev_composite: number | null
  /** @deprecated ADR-0018. Samples whose deprecated composite is defined. */
  n_defined_composite: number
  /** @deprecated ADR-0018. Not the headline. */
  mean_m1_score: number | null
  stddev_m1_score: number | null
  /** @deprecated ADR-0018. Samples whose deprecated m1 is defined. */
  n_defined_m1: number
  /**
   * Samples with a hard-gate `fail` or a distill/span failure.
   * Compress, cost, coherence, and fake replay do not count.
   */
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
  const row = parsed as {
    trace_id?: unknown
    segment_ids?: unknown
    intent_text?: unknown
    intent?: unknown
    skeleton_segment_ids?: unknown
    qa_solid?: unknown
  }
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
  if (row.qa_solid !== undefined) {
    if (typeof row.qa_solid !== 'boolean') {
      throw new Error('key-decisions.json qa_solid 必须是 boolean')
    }
    if (row.qa_solid) gold.qa_solid = true
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
 * @deprecated ADR-0018. Delegates to `compositeScore` (old six-gate formula,
 * including compress). Not the headline.
 */
export function scoredComposite(parts: BenchmarkParts): number | null {
  return compositeScore(parts)
}

/** @deprecated ADR-0018. Delegates to `m1Score`. Not the headline. */
export function scoredM1(parts: BenchmarkParts): number | null {
  return m1Score(parts)
}

/**
 * Active cells (ADR-0018). Compress is absent. Replay, coherence, and cost
 * never return `fail`. QA returns `fail` only for a solid case set below `qa_min`.
 */
export function metricStatuses(parts: BenchmarkParts): {
  key_step_recall: MetricStatus
  replay: MetricStatus
  qa: MetricStatus
  coherence: MetricStatus
  distill_cost_ratio: MetricStatus
} {
  const coherenceValue = coherenceMean(parts.coherence_scores)
  return {
    key_step_recall: optionalGate(
      parts.key_step_recall,
      (v) => v >= BENCHMARK_PASS.key_step_recall_min,
    ),
    replay: observedOrSkipped(parts.replay),
    qa:
      parts.qa_solid === true
        ? optionalGate(parts.qa, (v) => v >= BENCHMARK_PASS.qa_min)
        : observedOrSkipped(parts.qa),
    coherence: observedOrSkipped(coherenceValue),
    distill_cost_ratio: observedOrSkipped(
      Number.isFinite(parts.distill_cost_ratio) ? parts.distill_cost_ratio : null,
    ),
  }
}

/** Bench wiring: only `--with-l4` plus a verify run is `real`. */
export function classifyReplayFidelity(input: {
  replay: number | null
  real_l4: boolean
  replay_verified: boolean
}): ReplayFidelityKind {
  if (input.replay === null) return 'absent'
  if (input.real_l4 && input.replay_verified) return 'real'
  if (input.real_l4) return 'unverified'
  return 'fake'
}

/** Bench sample that failed distill (e.g. SpanFailure). fidelity null. Counts as n_gate_fail via process_failed, not compress. */
export function failedBenchSample(input: {
  bin: BenchmarkBin
  trace_id: string
  notes: readonly string[]
}): ScoredSample {
  const sample: ScoredSample = {
    trace_id: input.trace_id,
    bin: input.bin,
    metrics: {
      key_step_recall: { value: null, status: 'skipped' },
      replay: { value: null, status: 'skipped' },
      qa: { value: null, status: 'skipped' },
      coherence: { value: null, status: 'skipped' },
      distill_cost_ratio: { value: null, status: 'skipped' },
    },
    fidelity: null,
    replay_fidelity: 'absent',
    qa_solid: false,
    process_failed: true,
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
  const qaSolid = input.qa_solid === true
  const replayFidelity: ReplayFidelityKind = input.replay_fidelity ?? 'absent'
  const parts: BenchmarkParts = {
    compression_ratio: input.compression_ratio,
    key_step_recall: recall,
    replay: input.replay,
    qa: input.qa,
    coherence_scores: input.coherence_scores,
    distill_cost_ratio: input.distill_cost_ratio,
    bin: input.bin,
    qa_solid: qaSolid,
    ...(input.original_tokens !== undefined
      ? { original_tokens: input.original_tokens }
      : {}),
  }
  const statuses = metricStatuses(parts)
  const coherenceValue = coherenceMean(input.coherence_scores)
  const fidelity = fidelityScore({
    key_step_recall: recall,
    replay: input.replay,
    replay_fidelity: replayFidelity,
    qa: input.qa,
    qa_solid: qaSolid,
  })
  const sample: ScoredSample = {
    trace_id: input.trace_id,
    bin: input.bin,
    metrics: {
      key_step_recall: { value: recall, status: statuses.key_step_recall },
      replay: { value: input.replay, status: statuses.replay },
      qa: { value: input.qa, status: statuses.qa },
      coherence: { value: coherenceValue, status: statuses.coherence },
      distill_cost_ratio: {
        value: Number.isFinite(input.distill_cost_ratio) ? input.distill_cost_ratio : null,
        status: statuses.distill_cost_ratio,
      },
    },
    fidelity,
    replay_fidelity: replayFidelity,
    qa_solid: qaSolid,
    process_failed: false,
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
    const fidelityScores = table.samples
      .map((s) => s.fidelity)
      .filter((n): n is number => n !== null)
    const fidelityStats = meanStd(fidelityScores)
    table.mean_fidelity = fidelityStats.mean
    table.stddev_fidelity = fidelityStats.stddev
    table.n_defined_fidelity = fidelityScores.length
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
    mean_fidelity: null,
    stddev_fidelity: null,
    n_defined_fidelity: 0,
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
  if (sample.process_failed) return true
  return Object.values(sample.metrics).some((cell) => cell.status === 'fail')
}

function coherenceMean(scores: readonly number[] | null): number | null {
  if (scores === null || scores.length === 0) return null
  return scores.reduce((sum, n) => sum + n, 0) / scores.length
}

/** Finite number → observed (not a gate). Null / non-finite → skipped. */
function observedOrSkipped(value: number | null): MetricStatus {
  if (value === null || !Number.isFinite(value)) return 'skipped'
  return 'observed'
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
