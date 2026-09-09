import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, sniff } from '../adapters/claude_code.ts'
import { DEFAULT_CUT_PROFILE } from '../constant/compression.ts'
import { insertLabelDecisions, listLabels, ruleCoverage, type RuleCoverage } from '../data/data_label.ts'
import { getMetrics, insertMetrics, type MetricsRow } from '../data/data_metric.ts'
import {
  getTraceMeta,
  listSegments,
  listTraceIds,
  openDb,
  replaceSegments,
  runInTransaction,
  segmentRowToCard,
  upsertIntent,
  upsertTraceMeta,
  type Db,
} from '../data/data_segment.ts'
import { getCutPlan, getWarrant, insertCutPlan, insertWarrant } from '../data/data_warrant.ts'
import type { LabelDecision } from '../domain/label_decision.ts'
import { isSpanFailure } from '../domain/span_violation.ts'
import { computeDistillMetrics, type DistillMetrics } from '../eval/metrics.ts'
import { distill, resolveDistillMode, type DistillResult } from '../pipeline/orchestrator.ts'
import { renderHtml, type ReportModel } from '../report/html.ts'
import { renderLiveHtml } from '../report/live_page.ts'
import type { CutPlan, PlaybackCut } from '../types/cut_plan.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import {
  AdmissionError,
  isAdmissionError,
  type RawTrace,
} from '../types/raw_trace.ts'
import { error as logError, info as logInfo } from '../utils/logger.ts'
import { dumpAllJobs, dumpJobSnapshot, registerJobFromResult, resetLiveState, type StageState } from './live.ts'

export const EXIT_OK = 0
export const EXIT_OTHER = 1
export const EXIT_ADMISSION = 2
export const EXIT_SPAN = 3

export interface CliArgs {
  command: 'distill' | 'eval' | 'report' | 'live-dump'
  input_path: string
  profile_path?: string
  sqlite_path?: string
  out_dir?: string
  report_path?: string
  out_path?: string
  live_dump_dir?: string
  no_llm?: boolean
  help?: boolean
}

const L4_NOTE =
  'replay/qa 需真模型 L4（TRACE_DISTILLER_MODEL_L4）与干净会话，本命令不跑重放或 QA'

const HELP = `Usage:
  node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--out-dir dir] [--report out.html] [--live-dump dir] [--no-llm]
  node script/run-distill.ts eval <trace_id> --sqlite path
  node script/run-distill.ts report <trace_id> --sqlite path --out out.html
  node script/run-distill.ts live-dump --sqlite path [--out-dir dir] [trace_id]

--no-llm forces the conservative no-hole path. Without --no-llm, with_llm runs when a session backend is injected or TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B is set; otherwise no_llm.

FakeSessionBackend is for tests only. Production with_llm needs TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B.

eval reads distill metrics from SQLite. ${L4_NOTE}.

live dumps Distiller's own cut (segment / rules / holes / assemble, Partial Playback, warrant tail) to JSON + a self-contained live.html opened via file://. It is not the other agent's runtime. --live-dump writes <dir>/<job_id>.live.json and <dir>/live.html. No HTTP listen.

Two products: Training Cut / JSONL (train) and Playback + live/report HTML (review). CutProfile is the customisation surface.

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
  let out_path: string | undefined
  let live_dump_dir: string | undefined
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
    if (token === 'distill' || token === 'eval' || token === 'report' || token === 'live-dump') {
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
    if (token === '--out') {
      ;[out_path, i] = take(i, token)
      continue
    }
    if (token === '--live-dump') {
      ;[live_dump_dir, i] = take(i, token)
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
  if (out_path !== undefined) args.out_path = out_path
  if (live_dump_dir !== undefined) args.live_dump_dir = live_dump_dir
  if (no_llm !== undefined) args.no_llm = no_llm
  return args
}

export async function runCli(args: CliArgs): Promise<number> {
  if (args.help === true) {
    process.stderr.write(HELP)
    return EXIT_OK
  }
  if (args.command === 'eval') return runEval(args)
  if (args.command === 'report') return runReport(args)
  if (args.command === 'live-dump') return runLiveDump(args)
  if (args.input_path.length === 0) {
    process.stderr.write(HELP)
    return EXIT_OTHER
  }

  try {
    const raw = loadRaw(args.input_path)
    const profile = loadProfile(args.profile_path)
    const mode = resolveDistillMode({ no_llm: args.no_llm === true })
    const result = await distill({ raw, profile, mode })
    const outDir = args.out_dir ?? join('data', 'distilled')
    writeCuts(outDir, result)

    const computed = computeDistillMetrics(result)
    const metrics = metricsRowFrom(raw.meta.trace_id, computed)
    let coverage = coverageFromMetrics(computed)
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
      writeFileSync(
        args.report_path,
        renderHtml(toReportModel(result, coverage, computed)),
        'utf8',
      )
    }

    const job_id = registerJobFromResult(result, {
      holes: mode === 'with_llm' ? 'done' : 'skipped',
    })
    logInfo('distill registered live job', { job_id, trace_id: raw.meta.trace_id })

    let live_dump: string | undefined
    if (args.live_dump_dir !== undefined) {
      writeLiveDumpDir(args.live_dump_dir)
      live_dump = args.live_dump_dir
    }

    const summary: Record<string, unknown> = {
      trace_id: raw.meta.trace_id,
      compression_ratio: metrics.compression_ratio,
      out_dir: outDir,
      job_id,
    }
    if (live_dump !== undefined) summary.live_dump = live_dump
    process.stdout.write(`${JSON.stringify(summary)}\n`)
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
    upsertIntent(db, result.raw.meta.trace_id, result.view.intent_hypothesis)
    replaceSegments(db, result.raw.meta.trace_id, result.view.segments)
    insertLabelDecisions(db, result.raw.meta.trace_id, result.decisions)
    insertWarrant(db, result.warrant)
    insertCutPlan(db, result.plan)
    insertMetrics(db, metrics)
  })
}

function metricsRowFrom(trace_id: string, computed: DistillMetrics): MetricsRow {
  return {
    trace_id,
    compression_ratio: computed.compression_ratio,
    distill_cost_ratio: Number.isFinite(computed.distill_cost_ratio)
      ? computed.distill_cost_ratio
      : 0,
    key_step_recall: null,
    replay: null,
    qa: null,
    coherence: null,
    composite: null,
    rule_coverage: computed.rule_coverage,
    llm_segment_fraction: computed.llm_segment_fraction,
    fail_closed_count: computed.fail_closed_count,
  }
}

function coverageFromMetrics(computed: DistillMetrics): RuleCoverage {
  return {
    total: computed.total_segments,
    ruled: computed.ruled_count,
    llm: computed.llm_count,
    fail_closed: computed.fail_closed_count,
  }
}

function toReportModel(
  result: DistillResult,
  coverage: RuleCoverage,
  computed: DistillMetrics,
): ReportModel {
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
      compression_ratio: computed.compression_ratio,
      distill_cost_ratio: Number.isFinite(computed.distill_cost_ratio)
        ? computed.distill_cost_ratio
        : 0,
      llm_segment_fraction: computed.llm_segment_fraction,
    },
  }
}

function runEval(args: CliArgs): number {
  const sqlite = args.sqlite_path
  const trace_id = args.input_path
  if (sqlite === undefined || trace_id.length === 0) {
    process.stderr.write('eval 需要 <trace_id> --sqlite path\n')
    return EXIT_OTHER
  }
  const db = openDb(sqlite)
  try {
    const metrics = getMetrics(db, trace_id)
    if (metrics === undefined) {
      logError(`找不到 trace 指标: ${trace_id}`)
      return EXIT_OTHER
    }
    const coverage = ruleCoverage(db, trace_id)
    process.stdout.write(
      `${JSON.stringify({
        trace_id,
        compression_ratio: metrics.compression_ratio,
        distill_cost_ratio: metrics.distill_cost_ratio,
        rule_coverage: metrics.rule_coverage,
        llm_segment_fraction: metrics.llm_segment_fraction,
        fail_closed_count: metrics.fail_closed_count,
        total_segments: coverage.total,
        ruled_count: coverage.ruled,
        llm_count: coverage.llm,
        replay: null,
        qa: null,
        note: L4_NOTE,
      })}\n`,
    )
    return EXIT_OK
  } finally {
    db.close()
  }
}

function runReport(args: CliArgs): number {
  const sqlite = args.sqlite_path
  const trace_id = args.input_path
  const out = args.out_path
  if (sqlite === undefined || trace_id.length === 0 || out === undefined) {
    process.stderr.write('report 需要 <trace_id> --sqlite path --out out.html\n')
    return EXIT_OTHER
  }
  const db = openDb(sqlite)
  try {
    const model = reportModelFromDb(db, trace_id)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, renderHtml(model), 'utf8')
    process.stdout.write(`${JSON.stringify({ trace_id, out })}\n`)
    return EXIT_OK
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError(message)
    return EXIT_OTHER
  } finally {
    db.close()
  }
}

function writeLiveDumpDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const dump = dumpAllJobs()
  for (const row of dump.list_jobs) {
    const snap = dumpJobSnapshot(row.job_id)
    writeFileSync(join(dir, `${row.job_id}.live.json`), `${JSON.stringify(snap, null, 2)}\n`)
  }
  writeFileSync(join(dir, 'live.html'), renderLiveHtml(dump), 'utf8')
}

function runLiveDump(args: CliArgs): number {
  const sqlite = args.sqlite_path
  const outDir = args.live_dump_dir ?? args.out_dir
  if (sqlite === undefined || outDir === undefined) {
    process.stderr.write('live-dump 需要 --sqlite path 与 --out-dir 或 --live-dump dir\n')
    return EXIT_OTHER
  }
  resetLiveState()
  const db = openDb(sqlite)
  try {
    const ids = args.input_path.length > 0 ? [args.input_path] : listTraceIds(db)
    if (ids.length === 0) {
      logError('sqlite 里没有可导出的 trace')
      return EXIT_OTHER
    }
    for (const trace_id of ids) {
      const packed = distillResultFromDb(db, trace_id)
      registerJobFromResult(packed.result, { holes: packed.holes })
    }
    writeLiveDumpDir(outDir)
    process.stdout.write(
      `${JSON.stringify({
        sqlite,
        out_dir: outDir,
        jobs: dumpAllJobs().list_jobs.map((row) => row.job_id),
        live_html: join(outDir, 'live.html'),
      })}\n`,
    )
    return EXIT_OK
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError(message)
    return EXIT_OTHER
  } finally {
    db.close()
  }
}

function distillResultFromDb(
  db: Db,
  trace_id: string,
): { result: DistillResult; holes: StageState } {
  const metaRow = getTraceMeta(db, trace_id)
  if (metaRow === undefined) throw new Error(`找不到 trace: ${trace_id}`)
  const metrics = getMetrics(db, trace_id)
  if (metrics === undefined) throw new Error(`找不到 trace 指标: ${trace_id}`)
  const warrant = getWarrant(db, trace_id)
  if (warrant === undefined) throw new Error(`找不到凭证: ${trace_id}`)
  const planRow = getCutPlan(db, trace_id)
  if (planRow === undefined) throw new Error(`找不到 CutPlan: ${trace_id}`)
  const cards = listSegments(db, trace_id).map(segmentRowToCard)
  const byId = new Map(cards.map((card) => [card.id, card]))
  const playback: PlaybackCut = {
    trace_id,
    plan_ref: 'sqlite',
    cards: planRow.kept.flatMap((id) => {
      const card = byId.get(id)
      return card === undefined ? [] : [card]
    }),
    collapsed: planRow.collapsed,
  }
  const decisions: LabelDecision[] = listLabels(db, trace_id).map((row) => {
    const decision: LabelDecision = {
      segment_id: row.segment_id,
      label: row.label,
      source: { kind: row.source_kind, name: row.source_name },
      confidence: row.confidence,
    }
    if (row.rule_name !== null) decision.rule_name = row.rule_name
    return decision
  })
  const plan: CutPlan = {
    trace_id,
    profile_id: planRow.profile_id,
    warrant_ref: 'sqlite',
    kept: planRow.kept,
    collapsed: planRow.collapsed,
    dropped: planRow.dropped,
    span_ok: planRow.span_ok,
    span_violations: [],
  }
  const cutTokens = Math.round(metrics.compression_ratio * metaRow.total_tokens)
  const raw: RawTrace = {
    meta: {
      trace_id: metaRow.trace_id,
      source: metaRow.source,
      ground_truth_ref: metaRow.ground_truth_ref,
      total_tokens: metaRow.total_tokens,
    },
    ground_truth: { kind: 'task_confirmed', evidence_ref: metaRow.ground_truth_ref },
    turns: [],
    anchor_turn_ids: [],
  }
  const holes: StageState = decisions.some((d) => d.source.kind === 'llm') ? 'done' : 'skipped'
  return {
    holes,
    result: {
      raw,
      view: {
        meta: raw.meta,
        intent_hypothesis: metaRow.intent,
        skeleton: { version: 0, nodes: [] },
        segments: cards,
      },
      warrant,
      plan,
      training: {
        trace_id,
        plan_ref: 'sqlite',
        turns:
          cutTokens > 0
            ? [{ id: 'cut-tokens', role: 'assistant', content: '', tokens: cutTokens }]
            : [],
      },
      playback,
      decisions,
      unresolved_ids: [],
      metrics_ref: trace_id,
    },
  }
}

function reportModelFromDb(db: Db, trace_id: string): ReportModel {
  const metaRow = getTraceMeta(db, trace_id)
  if (metaRow === undefined) {
    throw new Error(`找不到 trace: ${trace_id}`)
  }
  const metrics = getMetrics(db, trace_id)
  if (metrics === undefined) {
    throw new Error(`找不到 trace 指标: ${trace_id}`)
  }
  const warrant = getWarrant(db, trace_id)
  if (warrant === undefined) {
    throw new Error(`找不到凭证: ${trace_id}`)
  }
  const plan = getCutPlan(db, trace_id)
  if (plan === undefined) {
    throw new Error(`找不到 CutPlan: ${trace_id}`)
  }
  const cards = listSegments(db, trace_id).map(segmentRowToCard)
  const byId = new Map(cards.map((card) => [card.id, card]))
  const playback: PlaybackCut = {
    trace_id,
    plan_ref: 'sqlite',
    cards: plan.kept.flatMap((id) => {
      const card = byId.get(id)
      return card === undefined ? [] : [card]
    }),
    collapsed: plan.collapsed,
  }
  const labels: LabelDecision[] = listLabels(db, trace_id).map((row) => {
    const decision: LabelDecision = {
      segment_id: row.segment_id,
      label: row.label,
      source: { kind: row.source_kind, name: row.source_name },
      confidence: row.confidence,
    }
    if (row.rule_name !== null) decision.rule_name = row.rule_name
    return decision
  })
  const coverage = ruleCoverage(db, trace_id)
  return {
    meta: {
      trace_id: metaRow.trace_id,
      source: metaRow.source,
      ground_truth_ref: metaRow.ground_truth_ref,
      total_tokens: metaRow.total_tokens,
    },
    intent: metaRow.intent,
    original_step_count: cards.length,
    kept_step_count: playback.cards.length,
    segments: cards,
    playback,
    warrant,
    labels,
    coverage,
    metrics: {
      compression_ratio: metrics.compression_ratio,
      distill_cost_ratio: metrics.distill_cost_ratio,
      llm_segment_fraction: metrics.llm_segment_fraction,
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
