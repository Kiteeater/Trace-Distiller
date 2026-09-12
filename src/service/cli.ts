import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse, sniff } from '../adapters/claude_code.ts'
import {
  DEFAULT_CUT_PROFILE,
  cutProfileForBin,
  type ProfileBin,
} from '../constant/compression.ts'
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
import {
  aggregateBins,
  BENCHMARK_BINS,
  failedBenchSample,
  isBenchmarkBin,
  keyDecisionFileCandidates,
  noteFromBenchDistillError,
  parseKeyDecisions,
  scoreSample,
  type KeyDecisionsGold,
  type ScoredSample,
} from '../eval/benchmark.ts'
import {
  resolveEmbeddingProvider,
  scoreHoleAVectorEfficiency,
  summarizeSkeletonPoints,
  type EmbeddingProvider,
  type HoleAVectorScore,
} from '../eval/vector_efficiency.ts'
import { computeDistillMetrics, compositeScore, type DistillMetrics } from '../eval/metrics.ts'
import { scoreKeptPathCoherence } from '../eval/coherence.ts'
import { L4_METRICS_ONLY_NOTE, runOptionalL4 } from '../eval/run.ts'
import { renderScoreboardMarkdown } from '../eval/scoreboard.ts'
import {
  FakeSessionBackend,
  holeModelsConfigured,
  l4BackendAvailable,
  setSessionBackend,
} from '../agent/sessions/open_session.ts'
import {
  distill,
  NO_LLM_REMOVED_MESSAGE,
  resolveDistillMode,
  type DistillResult,
} from '../pipeline/orchestrator.ts'

type DistillFn = typeof distill
/** Test-only hook: runBench calls this instead of distill directly. */
let benchDistillImpl: DistillFn = distill
export function setBenchDistillForTests(fn: DistillFn | undefined): void {
  benchDistillImpl = fn ?? distill
}
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
import { startLiveSocket, stopLiveSocket } from './live_socket.ts'
import {
  DEFAULT_PROFILE_PATH,
  DEFAULT_UTILITY_ARMS,
  DEFAULT_UTILITY_OUT_DIR,
  exportUtilityArms,
  parseHumanKeepFile,
  parseUtilityArms,
  resolveDistillerSha,
  type UtilityArm,
} from './export_utility.ts'

export const EXIT_OK = 0
export const EXIT_OTHER = 1
export const EXIT_ADMISSION = 2
export const EXIT_SPAN = 3

export interface CliArgs {
  command: 'distill' | 'eval' | 'report' | 'live-dump' | 'bench' | 'export-utility'
  input_path: string
  profile_path?: string
  sqlite_path?: string
  out_dir?: string
  report_path?: string
  out_path?: string
  live_dump_dir?: string
  live_socket_path?: string
  datasets_dir?: string
  /** @deprecated ADR-0010 removed; parseArgv rejects --no-llm */
  no_llm?: boolean
  fake_l4?: boolean
  /** bench 显式启用真 mint L4；缺省 FakeSessionBackend 防挂起（agent path） */
  with_l4?: boolean
  /** bench: only these bins (short|long|multi_dead_end). Empty = all. */
  bins?: ProfileBin[]
  /**
   * Bench-only Hole A vector efficiency (ADR-0011 b). Default on.
   * `--no-vector-efficiency` skips. Never an online stop signal.
   */
  vector_efficiency?: boolean
  qa?: boolean
  replay?: boolean
  /** export-utility: arms to write. Default raw,distilled,tools_only. */
  arms?: UtilityArm[]
  /** export-utility: JSON map of trace_id → keep segment/turn ids. */
  human_keep_path?: string
  /** export-utility: only these admitted trace ids. */
  trace_ids?: string[]
  help?: boolean
}

const HELP = `Usage:
  node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--out-dir dir] [--report out.html] [--live-dump dir] [--live-socket path] [--fake-l4]
  node script/run-distill.ts eval <trace_id> --sqlite path [--qa] [--replay]
  node script/run-distill.ts report <trace_id> --sqlite path --out out.html
  node script/run-distill.ts live-dump --sqlite path [--out-dir dir] [trace_id]
  node script/run-distill.ts bench [--dir benchmark/datasets] [--out-dir benchmark/out] [--fake-l4] [--with-l4] [--bin short|long|multi_dead_end] [--bins a,b] [--vector-efficiency|--no-vector-efficiency]
  node script/run-distill.ts export-utility <trace.jsonl|dir> [--out-dir benchmark/out-utility] [--arms raw,distilled,tools_only,human_curated] [--fake-l4] [--profile p.json] [--human-keep path] [--trace-ids id1,id2]

Agent-led cut only (ADR-0010). --no-llm / pure rules-only mode was removed — passing it errors. Distill requires an agent path: injected FakeSessionBackend / --fake-l4 (CI), or TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B.

FakeSessionBackend is for tests/CI. Production needs TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B.

OpenAI-compatible gateway: copy .env.example to .env. TRACE_DISTILLER_API_BASE + TRACE_DISTILLER_API_KEY register a custom provider. TRACE_DISTILLER_PROVIDER names it (else derived from the first TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B / TRACE_DISTILLER_MODEL_L4 slash prefix). TRACE_DISTILLER_API_TYPE is passed to pi registerProvider as api (default openai-completions). Models stay TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B / TRACE_DISTILLER_MODEL_L4 as provider/modelId (example provider/modelId). Mint/Macaron is one possible config, not required. Keys are never logged.

eval reads distill metrics from SQLite. --qa / --replay run L4 sessions when a backend is injected or TRACE_DISTILLER_MODEL_L4 is set; otherwise skip and note. L4 tokens are not distill cost. Real replay success needs a mapped benchmark/workspaces fixture + model; this command wires cwd when present.

bench scans --dir/{short,long,multi_dead_end}/*.jsonl, distills each sample, scores six gates, prints JSON, and writes scoreboard.md under --out-dir (default benchmark/out). Default injects FakeSessionBackend when not --with-l4 so overnight/CI cannot hang on mint (ADR-0010 agent path, not rules-only). --with-l4 opts into real mint L4 (session calls have SESSION_CALL_TIMEOUT_MS hard timeout; for long mint set TRACE_DISTILLER_SESSION_TIMEOUT_MS=300000). --fake-l4 also runs deterministic L4 heal + verify so composite can exceed 0 without mint. --bin / --bins select tracks so short and long are not forced into one hang-prone run; each selected bin uses its CutProfile valve (short=less aggressive dead_end + soft cost; long/multi=stronger collapse + keep floor ~8–15%) unless --profile overrides. Replay resolves benchmark/workspaces/manifest.json and materializes a temp cwd for mapped traces; unmapped traces skip replay (null, not fail=0); success is gated by workspace verify[] when present. QA near-JSON is repaired; still-unparseable after retries skips (null). Tracks are never averaged. Missing *.key-decisions.json skips key-step recall (M1). composite / m1_score are defined only when that score's required gates all pass (numeric values); otherwise null (rendered —), not 0 (ADR-0014). Required for m1: compression + key_step_recall. Required for composite: all six (short/small cost still soft). Skipped among the six keeps composite null. Means are over defined scores only; n_gate_fail counts samples with any metric fail. m1_score = compressionScore x key_step_recall when defined (cost fail does not undefine m1). Hole A vector efficiency (ADR-0011 b) is bench-only: a_eff = quality / log(1+tokens); quality = cosine(predicted intent vs optional gold intent_text) and optional skeleton_segment_ids recall. Default embedding is deterministic hash (no API key; TRACE_DISTILLER_EMBEDDING_PROVIDER=openai|http for a real provider). Not an online stop (sparse_intent still uses enough + hard budget). --no-vector-efficiency skips. L4/coherence failures surface as sample notes. Distill/SpanFailure per sample is recorded (composite null, compression fail; counts toward n_gate_fail) so the scoreboard still writes.

live dumps Distiller's own cut (segment / rules / holes / assemble, Partial Playback, warrant tail) to JSON + a self-contained live.html opened via file://. It is not the other agent's runtime. --live-dump writes <dir>/<job_id>.live.json and <dir>/live.html. Default transport is in-process registerJobFromResult + file dump. --live-socket <path> optionally listens on a Unix domain socket (JSON lines: {op:list_jobs|attach_job|...}) during distill; the command closes it on exit (stopLiveSocket unlinks the sock file) and does not keep the process alive. No HTTP listen. Never a TCP port.

export-utility writes ADR-0013 four-arm TrainingCut JSON (not SFT): <out>/manifest.json plus <out>/<arm>/<trace_id>.turns.json and tokens.json. Default arms: raw,distilled,tools_only. Distilled calls distill; injects FakeSessionBackend when --fake-l4 or Hole models unset (bench hang-safety). human_curated without --human-keep is skipped (stub + manifest), never silent raw. Token metric is ingest_raw_turn_tokens (sum of turn.tokens).

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
  let live_socket_path: string | undefined
  let datasets_dir: string | undefined
  let fake_l4: boolean | undefined
  let with_l4: boolean | undefined
  let bins: ProfileBin[] | undefined
  let vector_efficiency: boolean | undefined
  let qa: boolean | undefined
  let replay: boolean | undefined
  let arms: UtilityArm[] | undefined
  let human_keep_path: string | undefined
  let trace_ids: string[] | undefined

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
    if (
      token === 'distill' ||
      token === 'eval' ||
      token === 'report' ||
      token === 'live-dump' ||
      token === 'bench' ||
      token === 'export-utility'
    ) {
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
    if (token === '--live-socket') {
      ;[live_socket_path, i] = take(i, token)
      continue
    }
    if (token === '--dir') {
      ;[datasets_dir, i] = take(i, token)
      continue
    }
    if (token === '--no-llm') {
      throw new Error(NO_LLM_REMOVED_MESSAGE)
    }
    if (token === '--fake-l4') {
      fake_l4 = true
      continue
    }
    if (token === '--with-l4') {
      with_l4 = true
      continue
    }
    if (token === '--bin' || token === '--bins') {
      const [raw, nextI] = take(i, token)
      i = nextI
      const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (parts.length === 0) throw new Error(`${token} 需要 short|long|multi_dead_end`)
      const parsed: ProfileBin[] = []
      for (const part of parts) {
        if (!isBenchmarkBin(part)) {
          throw new Error(`未知 bin ${part}（期望 short|long|multi_dead_end）`)
        }
        if (!parsed.includes(part)) parsed.push(part)
      }
      bins = bins === undefined ? parsed : [...new Set([...bins, ...parsed])]
      continue
    }
    if (token === '--qa') {
      qa = true
      continue
    }
    if (token === '--replay') {
      replay = true
      continue
    }
    if (token === '--vector-efficiency') {
      vector_efficiency = true
      continue
    }
    if (token === '--no-vector-efficiency') {
      vector_efficiency = false
      continue
    }
    if (token === '--arms') {
      const [raw, nextI] = take(i, token)
      i = nextI
      arms = parseUtilityArms(raw)
      continue
    }
    if (token === '--human-keep') {
      ;[human_keep_path, i] = take(i, token)
      continue
    }
    if (token === '--trace-ids') {
      const [raw, nextI] = take(i, token)
      i = nextI
      const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (parts.length === 0) throw new Error(`${token} 需要至少一个 trace id`)
      trace_ids = parts
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
  if (live_socket_path !== undefined) args.live_socket_path = live_socket_path
  if (datasets_dir !== undefined) args.datasets_dir = datasets_dir
  if (fake_l4 !== undefined) args.fake_l4 = fake_l4
  if (with_l4 !== undefined) args.with_l4 = with_l4
  if (bins !== undefined) args.bins = bins
  if (vector_efficiency !== undefined) args.vector_efficiency = vector_efficiency
  if (qa !== undefined) args.qa = qa
  if (replay !== undefined) args.replay = replay
  if (arms !== undefined) args.arms = arms
  if (human_keep_path !== undefined) args.human_keep_path = human_keep_path
  if (trace_ids !== undefined) args.trace_ids = trace_ids
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
  if (args.command === 'bench') return runBench(args)
  if (args.command === 'export-utility') return runExportUtility(args)
  if (args.input_path.length === 0) {
    process.stderr.write(HELP)
    return EXIT_OTHER
  }

  let socketStarted = false
  try {
    if (args.live_socket_path !== undefined) {
      await startLiveSocket({ path: args.live_socket_path })
      socketStarted = true
      logInfo('live unix socket listening', { path: args.live_socket_path })
    }
    if (args.fake_l4 === true) {
      setSessionBackend(new FakeSessionBackend())
    }
    const raw = loadRaw(args.input_path)
    const profile = loadProfile(args.profile_path)
    const mode = resolveDistillMode({})
    let result: DistillResult
    try {
      result = await distill({ raw, profile, mode })
    } finally {
      if (args.fake_l4 === true) setSessionBackend(undefined)
    }
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

    const holeFailed = (result.hole_notes?.length ?? 0) > 0
    const holesStage = holeFailed ? 'error' : 'done'
    const job_id = registerJobFromResult(result, {
      holes: holesStage,
    })
    logInfo('distill registered live job', { job_id, trace_id: raw.meta.trace_id })
    if (holeFailed) {
      logInfo('distill hole notes', { notes: result.hole_notes })
    }

    let live_dump: string | undefined
    if (args.live_dump_dir !== undefined) {
      writeLiveDumpDir(args.live_dump_dir)
      live_dump = args.live_dump_dir
    }

    const summary: Record<string, unknown> = {
      trace_id: raw.meta.trace_id,
      compression_ratio: metrics.compression_ratio,
      distill_cost_ratio: metrics.distill_cost_ratio,
      hole_a_plus_b_tokens: result.hole_a_plus_b_tokens ?? 0,
      out_dir: outDir,
      job_id,
      mode,
    }
    if (result.hole_notes !== undefined && result.hole_notes.length > 0) {
      summary.hole_notes = result.hole_notes
    }
    if (live_dump !== undefined) summary.live_dump = live_dump
    if (args.live_socket_path !== undefined) summary.live_socket = args.live_socket_path
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
  } finally {
    if (socketStarted) await stopLiveSocket()
  }
}

async function runExportUtility(args: CliArgs): Promise<number> {
  if (args.input_path.length === 0) {
    process.stderr.write(HELP)
    return EXIT_OTHER
  }
  const outDir = args.out_dir ?? DEFAULT_UTILITY_OUT_DIR
  const arms = args.arms ?? [...DEFAULT_UTILITY_ARMS]
  const profile = loadProfile(args.profile_path)
  const profilePath = args.profile_path ?? DEFAULT_PROFILE_PATH
  const wantFake = args.fake_l4 === true || !holeModelsConfigured()
  if (wantFake) {
    setSessionBackend(new FakeSessionBackend())
  }
  try {
    let humanKeepByTrace: Record<string, string[]> | undefined
    if (args.human_keep_path !== undefined) {
      humanKeepByTrace = parseHumanKeepFile(readFileSync(args.human_keep_path, 'utf8'))
    }
    const manifest = await exportUtilityArms({
      inputPath: args.input_path,
      outDir,
      arms,
      profile,
      profilePath,
      distillerSha: resolveDistillerSha(),
      fakeL4: wantFake,
      ...(humanKeepByTrace !== undefined ? { humanKeepByTrace } : {}),
      ...(args.trace_ids !== undefined ? { traceIds: args.trace_ids } : {}),
    })
    process.stdout.write(`${JSON.stringify({ out_dir: outDir, ...manifest })}\n`)
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
  } finally {
    if (wantFake) setSessionBackend(undefined)
  }
}

function loadRaw(inputPath: string): RawTrace {
  const text = readFileSync(inputPath, 'utf8')
  if (!sniff(text)) {
    throw new AdmissionError('unparseable', '无法解析这条 Trace，拒绝入库')
  }
  return parse(text)
}

function loadProfile(profilePath: string | undefined, base: CutProfile = DEFAULT_CUT_PROFILE): CutProfile {
  if (profilePath === undefined) return base
  const parsed: unknown = JSON.parse(readFileSync(profilePath, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`无效 CutProfile: ${profilePath}`)
  }
  const row = parsed as Partial<CutProfile>
  const merged: CutProfile = {
    ...base,
    ...row,
    compression_ratio: {
      ...base.compression_ratio,
      ...(row.compression_ratio ?? {}),
    },
    span: { ...base.span, ...(row.span ?? {}) },
    dead_end: { ...base.dead_end, ...(row.dead_end ?? {}) },
  }
  if (row.label_window_size !== undefined) merged.label_window_size = row.label_window_size
  if (row.keep_ratio_floor !== undefined) merged.keep_ratio_floor = row.keep_ratio_floor
  return merged
}

function resolveBenchBins(args: CliArgs): ProfileBin[] {
  if (args.bins !== undefined && args.bins.length > 0) return args.bins
  return [...BENCHMARK_BINS]
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

const DEFAULT_BENCH_DIR = join('benchmark', 'datasets')

async function runBench(args: CliArgs): Promise<number> {
  const dir = args.datasets_dir ?? (args.input_path.length > 0 ? args.input_path : DEFAULT_BENCH_DIR)
  const outDir = args.out_dir ?? join('benchmark', 'out')
  const selectedBins = resolveBenchBins(args)
  const cwd = process.cwd()
  // ADR-0010: agent path only. Without --with-l4, inject FakeSessionBackend (hang-safe agent path).
  const wantRealL4 = args.with_l4 === true
  const wantFakeL4 = args.fake_l4 === true
  if (!wantRealL4) {
    setSessionBackend(new FakeSessionBackend())
  }
  const mode = resolveDistillMode({})
  // Default / --fake-l4 → FakeSessionBackend. --with-l4 → real mint when MODEL_L4 set. Else L4 skip (no hang).
  const runL4 = wantFakeL4 || (wantRealL4 && l4BackendAvailable())
  const runCoherence =
    wantFakeL4 || (wantRealL4 && (holeModelsConfigured() || runL4))
  const samples: ScoredSample[] = []
  let holeAEmbedder: EmbeddingProvider | undefined
  let holeAVectorProviderNote: string | undefined
  if (args.vector_efficiency !== false) {
    try {
      holeAEmbedder = resolveEmbeddingProvider()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      holeAVectorProviderNote = `hole_a_vector skipped: embedding provider (${message})`
      logError(holeAVectorProviderNote)
    }
  }
  try {
    for (const bin of selectedBins) {
      const binDir = join(dir, bin)
      const profile = loadProfile(args.profile_path, cutProfileForBin(bin))
      for (const jsonl of listBinJsonl(binDir)) {
        // Fallback id if loadRaw itself throws before meta is known.
        let trace_id = basename(jsonl, '.jsonl')
        try {
          const raw = loadRaw(jsonl)
          trace_id = raw.meta.trace_id
          const result = await benchDistillImpl({ raw, profile, mode })
          const computed = computeDistillMetrics(result)
          const gold = loadGold(raw.meta.trace_id, cwd, jsonl)

          let qa: number | null = null
          let replay: number | null = null
          let coherence_scores: number[] | null = null
          const sampleNotes: string[] = []
          if (runL4) {
            const l4 = await runOptionalL4({
              intent: result.view.intent_hypothesis,
              playback: result.playback,
              run_qa: true,
              run_replay: true,
              repo_root: cwd,
            })
            qa = l4.qa
            replay = l4.replay
            sampleNotes.push(...l4.notes)
          } else if (!wantFakeL4 && !wantRealL4) {
            sampleNotes.push(
              'l4 skipped: pass --with-l4 for real mint or --fake-l4 for CI (default avoids hang)',
            )
          } else if (wantRealL4 && !l4BackendAvailable()) {
            sampleNotes.push(
              'l4 skipped: --with-l4 set but no TRACE_DISTILLER_MODEL_L4 / injected backend',
            )
          }
          if (runCoherence) {
            const coh = await scoreKeptPathCoherence({
              kept_ids: result.plan.kept,
              cards: result.view.segments,
              skeleton: result.view.skeleton,
            })
            coherence_scores = coh.scores
            sampleNotes.push(...coh.notes)
          }

          let hole_a_vector: HoleAVectorScore | null | undefined
          if (args.vector_efficiency === false) {
            // opt-out
          } else if (holeAEmbedder === undefined) {
            if (holeAVectorProviderNote !== undefined) sampleNotes.push(holeAVectorProviderNote)
          } else {
            try {
              hole_a_vector = await scoreHoleAVector({
                result,
                gold,
                embedder: holeAEmbedder,
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              sampleNotes.push(`hole_a_vector skipped: ${message}`)
            }
          }

          samples.push(
            scoreSample({
              bin,
              trace_id: raw.meta.trace_id,
              compression_ratio: computed.compression_ratio,
              distill_cost_ratio: computed.distill_cost_ratio,
              original_tokens: raw.meta.total_tokens,
              kept: result.plan.kept,
              gold_segment_ids: gold === null ? null : gold.segment_ids,
              replay,
              qa,
              coherence_scores,
              ...(sampleNotes.length > 0 ? { notes: sampleNotes } : {}),
              ...(hole_a_vector !== undefined ? { hole_a_vector } : {}),
            }),
          )
        } catch (error) {
          const note = noteFromBenchDistillError(error)
          logError(`bench sample failed (${bin}/${trace_id}): ${note}`)
          samples.push(
            failedBenchSample({
              bin,
              trace_id,
              notes: [note],
            }),
          )
        }
      }
    }
    const report = aggregateBins(samples)
    const payload = {
      dir,
      out_dir: outDir,
      mode,
      l4: runL4,
      fake_l4: args.fake_l4 === true,
      with_l4: wantRealL4,
      selected_bins: selectedBins,
      bins: report.bins,
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'scoreboard.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    writeFileSync(
      join(outDir, 'scoreboard.md'),
      renderScoreboardMarkdown({
        dir,
        mode,
        l4: runL4,
        bins: report.bins,
      }),
      'utf8',
    )
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return EXIT_OK
  } catch (error) {
    if (isAdmissionError(error)) {
      logError(humanAdmission(error))
      return EXIT_ADMISSION
    }
    const message = error instanceof Error ? error.message : String(error)
    logError(message)
    return EXIT_OTHER
  } finally {
    setSessionBackend(undefined)
  }
}

function listBinJsonl(binDir: string): string[] {
  if (!existsSync(binDir)) return []
  return readdirSync(binDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(binDir, name))
    .sort()
}

function loadGold(traceId: string, cwd: string, jsonlPath: string): KeyDecisionsGold | null {
  const candidates = keyDecisionFileCandidates({
    trace_id: traceId,
    cwd,
    jsonl_path: jsonlPath,
  })
  for (const path of candidates) {
    if (!existsSync(path)) continue
    return parseKeyDecisions(readFileSync(path, 'utf8'))
  }
  return null
}

async function scoreHoleAVector(input: {
  result: { view: { intent_hypothesis: { text: string }; skeleton: { nodes: ReadonlyArray<{ kind: string; note: string; segment_ids: string[] }> } }; hole_a?: { tokens: number; segments_read: string[] } }
  gold: KeyDecisionsGold | null
  embedder: EmbeddingProvider | undefined
}): Promise<HoleAVectorScore> {
  const nodes = input.result.view.skeleton.nodes
  const predicted_skeleton_segment_ids: string[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const id of node.segment_ids) {
      if (seen.has(id)) continue
      seen.add(id)
      predicted_skeleton_segment_ids.push(id)
    }
  }
  const summary = summarizeSkeletonPoints(nodes)
  return await scoreHoleAVectorEfficiency({
    predicted_intent: input.result.view.intent_hypothesis.text,
    ...(summary.length > 0 ? { predicted_skeleton_summary: summary } : {}),
    predicted_skeleton_segment_ids,
    gold_intent: input.gold?.intent_text ?? null,
    gold_skeleton_segment_ids: input.gold?.skeleton_segment_ids ?? null,
    tokens: input.result.hole_a?.tokens ?? 0,
    segments_read: input.result.hole_a?.segments_read.length ?? 0,
    ...(input.embedder !== undefined ? { embedder: input.embedder } : {}),
  })
}

async function runEval(args: CliArgs): Promise<number> {
  const sqlite = args.sqlite_path
  const trace_id = args.input_path
  if (sqlite === undefined || trace_id.length === 0) {
    process.stderr.write('eval 需要 <trace_id> --sqlite path [--qa] [--replay]\n')
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
    const packed = distillResultFromDb(db, trace_id)
    const run_qa = args.qa === true
    const run_replay = args.replay === true
    const l4 = await runOptionalL4({
      intent: packed.result.view.intent_hypothesis,
      playback: packed.result.playback,
      run_qa,
      run_replay,
      repo_root: process.cwd(),
    })
    const qa = l4.qa ?? metrics.qa
    const replay = l4.replay ?? metrics.replay
    const composite = compositeScore({
      compression_ratio: metrics.compression_ratio,
      key_step_recall: metrics.key_step_recall,
      replay,
      qa,
      coherence_scores: null,
      distill_cost_ratio: metrics.distill_cost_ratio,
    })
    if (l4.qa !== null || l4.replay !== null) {
      insertMetrics(db, {
        ...metrics,
        qa,
        replay,
        composite,
      })
    }
    const notes = [...l4.notes]
    if (!run_qa && !run_replay) notes.push(L4_METRICS_ONLY_NOTE)
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
        key_step_recall: metrics.key_step_recall,
        replay,
        qa,
        coherence: metrics.coherence,
        composite,
        note: notes.join('; '),
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
