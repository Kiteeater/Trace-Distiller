import { compressionRatio } from '../eval/metrics.ts'
import type { DistillResult } from '../pipeline/orchestrator.ts'
import type { PlaybackCut } from '../types/cut_plan.ts'
import type { CutWarrantEntry } from '../types/cut_warrant.ts'
import type { SegmentCard } from '../types/segment.ts'

/**
 * Live 复盘工具闭集（已拍板）。只读订阅 Distiller 自己的裁剪 job，不是对方 agent。
 * 源 = 进程内 `registerJobFromResult` 内存表。禁止 HTTP listen。
 * 可选 Unix domain socket 见 `live_socket.ts`（默认关闭，不替代本表）。
 */
export const LIVE_TOOL_NAMES = [
  'list_jobs',
  'attach_job',
  'detach_job',
  'get_cut_progress',
  'get_partial_result',
  'get_warrant_tail',
] as const

export type LiveToolName = (typeof LIVE_TOOL_NAMES)[number]

export type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'error'

export interface DistillJobSummary {
  job_id: string
  trace_id: string
  status: 'done'
  attached: boolean
}

export interface CutProgress {
  job_id: string
  trace_id: string
  segment: StageState
  rules: StageState
  holes: StageState
  assemble: StageState
  /** 压缩率暂值：剪后 training token / 原 token。 */
  compression_ratio: number
}

export interface PartialResult {
  job_id: string
  playback: PlaybackCut
  cards: SegmentCard[]
}

export class UnknownJobError extends Error {
  readonly job_id: string

  constructor(job_id: string) {
    super(`unknown distill job: ${job_id}`)
    this.name = 'UnknownJobError'
    this.job_id = job_id
  }
}

interface StoredJob {
  job_id: string
  result: DistillResult
  holes: StageState
}

const jobs = new Map<string, StoredJob>()
const attached = new Set<string>()
let seq = 0

export function resetLiveState(): void {
  jobs.clear()
  attached.clear()
  seq = 0
}

/** 从已完成的 DistillResult 登记一条可订阅 job。不进 pipeline，不调 LLM。 */
export function registerJobFromResult(
  result: DistillResult,
  opts?: { job_id?: string; holes?: StageState },
): string {
  seq += 1
  const job_id = opts?.job_id ?? `job-${seq}`
  jobs.set(job_id, {
    job_id,
    result,
    holes: opts?.holes ?? 'skipped',
  })
  return job_id
}

export function list_jobs(): DistillJobSummary[] {
  return [...jobs.values()].map((job) => toSummary(job))
}

export function attach_job(job_id: string): DistillJobSummary {
  const job = requireJob(job_id)
  attached.add(job_id)
  return toSummary(job)
}

export function detach_job(job_id: string): DistillJobSummary {
  const job = requireJob(job_id)
  attached.delete(job_id)
  return toSummary(job)
}

export function get_cut_progress(job_id: string): CutProgress {
  const job = requireJob(job_id)
  const original = job.result.raw.meta.total_tokens
  const cut = job.result.training.turns.reduce((sum, turn) => sum + turn.tokens, 0)
  return {
    job_id: job.job_id,
    trace_id: job.result.raw.meta.trace_id,
    segment: 'done',
    rules: 'done',
    holes: job.holes,
    assemble: 'done',
    compression_ratio: compressionRatio({ original_tokens: original, cut_tokens: cut }),
  }
}

export function get_partial_result(job_id: string): PartialResult {
  const job = requireJob(job_id)
  const playback = job.result.playback
  return {
    job_id: job.job_id,
    playback,
    cards: playback.cards,
  }
}

/** CutWarrant 尾：默认整份；传入 limit 则取末尾 limit 条。 */
export function get_warrant_tail(job_id: string, limit?: number): CutWarrantEntry[] {
  const job = requireJob(job_id)
  const entries = job.result.warrant.entries
  if (limit === undefined || limit >= entries.length) return entries.slice()
  if (limit <= 0) return []
  return entries.slice(-limit)
}

function requireJob(job_id: string): StoredJob {
  const job = jobs.get(job_id)
  if (job === undefined) throw new UnknownJobError(job_id)
  return job
}

function toSummary(job: StoredJob): DistillJobSummary {
  return {
    job_id: job.job_id,
    trace_id: job.result.raw.meta.trace_id,
    status: 'done',
    attached: attached.has(job.job_id),
  }
}

/**
 * 六工具只读快照。不 attach / detach，不进 pipeline，不写盘。
 * 字段名与 LIVE_TOOL_NAMES 对齐，便于 dump 与页面对账。
 */
export interface LiveJobSnapshot {
  list_jobs: DistillJobSummary[]
  attach_job: DistillJobSummary
  detach_job: DistillJobSummary
  get_cut_progress: CutProgress
  get_partial_result: PartialResult
  get_warrant_tail: CutWarrantEntry[]
}

export interface LiveDump {
  list_jobs: DistillJobSummary[]
  jobs: LiveJobSnapshot[]
}

export function dumpJobSnapshot(job_id: string): LiveJobSnapshot {
  const job = requireJob(job_id)
  const summary = toSummary(job)
  return {
    list_jobs: list_jobs(),
    attach_job: summary,
    detach_job: summary,
    get_cut_progress: get_cut_progress(job_id),
    get_partial_result: get_partial_result(job_id),
    get_warrant_tail: get_warrant_tail(job_id),
  }
}

export function dumpAllJobs(): LiveDump {
  const listed = list_jobs()
  return {
    list_jobs: listed,
    jobs: listed.map((row) => dumpJobSnapshot(row.job_id)),
  }
}
