import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, sniff } from '../adapters/claude_code.ts'
import { DEFAULT_CUT_PROFILE } from '../constant/compression.ts'
import { insertLabelDecisions, ruleCoverage, type RuleCoverage } from '../data/data_label.ts'
import { insertMetrics, type MetricsRow } from '../data/data_metric.ts'
import {
  openDb,
  replaceSegments,
  runInTransaction,
  upsertTraceMeta,
  type Db,
} from '../data/data_segment.ts'
import { insertCutPlan, insertWarrant } from '../data/data_warrant.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../domain/cut_decision.ts'
import { isSpanFailure } from '../domain/span_violation.ts'
import { distill, type DistillMode, type DistillResult } from '../pipeline/orchestrator.ts'
import { renderHtml, type ReportModel } from '../report/html.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import {
  AdmissionError,
  isAdmissionError,
  type RawTrace,
} from '../types/raw_trace.ts'
import { error as logError, info as logInfo } from '../utils/logger.ts'
import { registerJobFromResult } from './live.ts'

export const EXIT_OK = 0
export const EXIT_OTHER = 1
export const EXIT_ADMISSION = 2
export const EXIT_SPAN = 3

export interface CliArgs {
  command: 'distill' | 'eval' | 'report'
  input_path: string
  profile_path?: string
  sqlite_path?: string
  out_dir?: string
  report_path?: string
  no_llm?: boolean
  help?: boolean
}

const HELP = `Usage:
  node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--out-dir dir] [--report out.html] [--no-llm]

Default mode is no_llm (holes A/B are not implemented). --no-llm is the documented conservative path.

Exit codes:
  0  success
  2  准入拒绝（无 Ground Truth / 无法解析 / 任务边界不清）
  3  span 约束失败
  1  other

No HTTP server. Do not pass API keys here; this command does not import pi.
`

export function parseArgv(argv: string[]): CliArgs {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'distill', input_path: '', help: true }
  }

  let command: CliArgs['command'] | undefined
  let input_path: string | undefined
  let profile_path: string | undefined
  let sqlite_path: string | undefined
  let out_dir: string | undefined
  let report_path: string | undefined
  let no_llm: boolean | undefined

  const take = (i: number, flag: string): [string, number] => {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('-')) {
      throw new Error(`${flag} 需要一个参数`)
    }
    return [next, i + 1]
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (token === 'distill' || token === 'eval' || token === 'report') {
      if (command !== undefined) throw new Error(`重复的子命令 ${token}`)
      command = token
      continue
    }
    if (token === '--profile') {
      ;[profile_path, i] = take(i, token)
      continue
    }
    if (token === '--sqlite') {
      ;[sqlite_path, i] = take(i, token)
      continue
    }
    if (token === '--out-dir') {
      ;[out_dir, i] = take(i, token)
      continue
    }
    if (token === '--report') {
      ;[report_path, i] = take(i, token)
      continue
    }
    if (token === '--no-llm') {
      no_llm = true
      continue
    }
    if (token.startsWith('-')) {
      throw new Error(`未知参数 ${token}`)
    }
    if (input_path !== undefined) {
      throw new Error(`多余位置参数 ${token}`)
    }
    input_path = token
  }

  const args: CliArgs = {
    command: command ?? 'distill',
    input_path: input_path ?? '',
  }
  if (profile_path !== undefined) args.profile_path = profile_path
  if (sqlite_path !== undefined) args.sqlite_path = sqlite_path
  if (out_dir !== undefined) args.out_dir = out_dir
  if (report_path !== undefined) args.report_path = report_path
  if (no_llm !== undefined) args.no_llm = no_llm
  return args
}

export async function runCli(args: CliArgs): Promise<number> {
  if (args.help === true) {
    process.stderr.write(HELP)
    return EXIT_OK
  }
  if (args.command !== 'distill') {
    process.stderr.write(`${args.command} 尚未实现\n`)
    return EXIT_OTHER
  }
  if (args.input_path.length === 0) {
    process.stderr.write(HELP)
    return EXIT_OTHER
  }

  try {
    const raw = loadRaw(args.input_path)
    const profile = loadProfile(args.profile_path)
    const mode: DistillMode = 'no_llm'
    const result = await distill({ raw, profile, mode })
    const outDir = args.out_dir ?? join('data', 'distilled')
    writeCuts(outDir, result)

    const metrics = metricsFrom(result)
    let coverage = coverageFromResult(result)
    if (args.sqlite_path !== undefined) {
      const db = openDb(args.sqlite_path)
      try {
        persistDistill(db, result, metrics)
        coverage = ruleCoverage(db, raw.meta.trace_id)
      } finally {
        db.close()
      }
    }

    if (args.report_path !== undefined) {
      writeFileSync(args.report_path, renderHtml(toReportModel(result, coverage, metrics)), 'utf8')
    }

    const job_id = registerJobFromResult(result)
    logInfo('distill registered live job', { job_id, trace_id: raw.meta.trace_id })

    process.stdout.write(
      `${JSON.stringify({
        trace_id: raw.meta.trace_id,
        compression_ratio: metrics.compression_ratio,
        out_dir: outDir,
        job_id,
      })}\n`,
    )
    return EXIT_OK
  } catch (error) {
    if (isAdmissionError(error)) {
      logError(humanAdmission(error))
      return EXIT_ADMISSION
    }
    if (isSpanFailure(error)) {
      logError('span 约束失败：剪后相邻步不够得着')
      return EXIT_SPAN
    }
    const message = error instanceof Error ? error.message : String(error)
    logError(message)
    return EXIT_OTHER
  }
}

function loadRaw(inputPath: string): RawTrace {
  const text = readFileSync(inputPath, 'utf8')
  if (!sniff(text)) {
    throw new AdmissionError('unparseable', '无法解析这条 Trace，拒绝入库')
  }
  return parse(text)
}

function loadProfile(profilePath: string | undefined): CutProfile {
  if (profilePath === undefined) return DEFAULT_CUT_PROFILE
  const parsed: unknown = JSON.parse(readFileSync(profilePath, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`无效 CutProfile: ${profilePath}`)
  }
  const row = parsed as Partial<CutProfile>
  return {
    ...DEFAULT_CUT_PROFILE,
    ...row,
    compression_ratio: {
      ...DEFAULT_CUT_PROFILE.compression_ratio,
      ...(row.compression_ratio ?? {}),
    },
    span: { ...DEFAULT_CUT_PROFILE.span, ...(row.span ?? {}) },
    dead_end: { ...DEFAULT_CUT_PROFILE.dead_end, ...(row.dead_end ?? {}) },
  }
}

function writeCuts(outDir: string, result: DistillResult): void {
  mkdirSync(outDir, { recursive: true })
  const stem = sanitizeTraceId(result.raw.meta.trace_id)
  writeFileSync(join(outDir, `${stem}-training.json`), `${JSON.stringify(result.training, null, 2)}\n`)
  writeFileSync(join(outDir, `${stem}-playback.json`), `${JSON.stringify(result.playback, null, 2)}\n`)
}

function persistDistill(db: Db, result: DistillResult, metrics: MetricsRow): void {
  runInTransaction(db, () => {
    upsertTraceMeta(db, result.raw)
    replaceSegments(db, result.raw.meta.trace_id, result.view.segments)
    insertLabelDecisions(db, result.raw.meta.trace_id, result.decisions)
    insertWarrant(db, result.warrant)
    insertCutPlan(db, result.plan)
    insertMetrics(db, metrics)
  })
}

function metricsFrom(result: DistillResult): MetricsRow {
  const after = result.training.turns.reduce((sum, turn) => sum + turn.tokens, 0)
  const before = result.raw.meta.total_tokens
  const compression_ratio = before > 0 ? after / before : 0
  return {
    trace_id: result.raw.meta.trace_id,
    compression_ratio,
    distill_cost_ratio: 0,
    key_step_recall: null,
    replay: null,
    qa: null,
    coherence: null,
    composite: null,
  }
}

function coverageFromResult(result: DistillResult): RuleCoverage {
  const total = result.view.segments.length
  const ruled = result.decisions.filter((d) => d.source.kind === 'rule').length
  const llm = result.decisions.filter((d) => d.source.kind === 'llm').length
  const fail_closed = result.warrant.entries.filter((e) => e.source.name === FAIL_CLOSED_KEEP_RULE).length
  return { total, ruled, llm, fail_closed }
}

function toReportModel(
  result: DistillResult,
  coverage: RuleCoverage,
  metrics: MetricsRow,
): ReportModel {
  const llm_segment_fraction = coverage.total > 0 ? coverage.llm / coverage.total : 0
  return {
    meta: result.raw.meta,
    intent: result.view.intent_hypothesis,
    original_step_count: result.view.segments.length,
    kept_step_count: result.playback.cards.length,
    segments: result.view.segments,
    playback: result.playback,
    warrant: result.warrant,
    labels: result.decisions,
    coverage,
    metrics: {
      compression_ratio: metrics.compression_ratio,
      distill_cost_ratio: metrics.distill_cost_ratio,
      llm_segment_fraction,
    },
  }
}

function sanitizeTraceId(traceId: string): string {
  const cleaned = traceId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'trace'
}

function humanAdmission(error: AdmissionError): string {
  switch (error.code) {
    case 'no_ground_truth':
      return '无 Ground Truth，拒绝入库'
    case 'unparseable':
      return '无法解析这条 Trace，拒绝入库'
    case 'multi_task_ambiguous':
      return '一条记录里任务边界不清，拒绝入库'
  }
}
