import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { parse, sniff } from '../adapters/claude_code.ts'
import { distill, resolveDistillMode } from '../pipeline/orchestrator.ts'
import { segment } from '../pipeline/segmenter.ts'
import { cloneTurn, filterToolsOnly } from '../pipeline/tools_only.ts'
import type { TrainingCut } from '../types/cut_plan.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import {
  AdmissionError,
  isAdmissionError,
  type RawTrace,
  type RawTurn,
} from '../types/raw_trace.ts'

export const UTILITY_ARMS = ['raw', 'distilled', 'tools_only', 'human_curated'] as const
export type UtilityArm = (typeof UTILITY_ARMS)[number]

export const DEFAULT_UTILITY_ARMS: readonly UtilityArm[] = ['raw', 'distilled', 'tools_only']
export const DEFAULT_UTILITY_OUT_DIR = join('benchmark', 'out-utility')
export const TOKEN_METRIC = 'ingest_raw_turn_tokens' as const
export const DISTILLER_SHA_ENV = 'TRACE_DISTILLER_SHA'
export const DEFAULT_PROFILE_PATH = 'src/constant/compression.ts'

export function isUtilityArm(value: string): value is UtilityArm {
  return (UTILITY_ARMS as readonly string[]).includes(value)
}

export function parseUtilityArms(raw: string): UtilityArm[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) {
    throw new Error('--arms 需要 raw|distilled|tools_only|human_curated')
  }
  const out: UtilityArm[] = []
  for (const part of parts) {
    if (!isUtilityArm(part)) {
      throw new Error(`未知 arm ${part}（期望 raw|distilled|tools_only|human_curated）`)
    }
    if (!out.includes(part)) out.push(part)
  }
  return out
}

export interface UtilitySkip {
  trace_id: string
  reason: string
  path?: string
  arm?: UtilityArm
}

export interface UtilityTraceTokens {
  turn_count: number
  tokens: number
}

export interface UtilityArmTokens {
  arm: UtilityArm
  traces: Record<string, UtilityTraceTokens>
  pool_tokens: number
  pool_turns: number
  skipped?: boolean
  skip_reason?: string
}

export type ArmSkipNote = { skipped: true; reason: string } | UtilitySkip[]

export interface UtilityManifest {
  distiller_sha: string
  profile_path: string
  profile_id: string
  arms: UtilityArm[]
  trace_ids: {
    exported: string[]
    skipped: UtilitySkip[]
  }
  token_metric: typeof TOKEN_METRIC
  skips: Partial<Record<UtilityArm, ArmSkipNote>>
  fake_l4: boolean
}

export interface ExportUtilityInput {
  inputPath: string
  outDir: string
  arms: readonly UtilityArm[]
  profile: CutProfile
  profilePath: string
  distillerSha: string
  fakeL4: boolean
  humanKeepByTrace?: Record<string, string[]>
  traceIds?: string[]
}

export function resolveDistillerSha(
  env: NodeJS.Dict<string> = process.env,
  cwd = process.cwd(),
): string {
  const override = env[DISTILLER_SHA_ENV]
  if (typeof override === 'string' && override.length > 0) return override
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  if (result.status === 0) {
    const sha = result.stdout.trim()
    if (sha.length > 0) return sha
  }
  return 'unknown'
}

export function sumTurnTokens(turns: readonly RawTurn[]): number {
  return turns.reduce((sum, t) => sum + t.tokens, 0)
}

export function wrapTrainingCut(
  trace_id: string,
  turns: readonly RawTurn[],
  plan_ref: string,
): TrainingCut {
  return { trace_id, plan_ref, turns: turns.map(cloneTurn) }
}

/**
 * Keep RawTurns whose id is listed, or that belong to a listed segment id
 * (segmenter Action Unit raw_refs). Missing ids are returned, not invented.
 */
export function filterByKeepIds(
  raw: RawTrace,
  keepIds: readonly string[],
): { turns: RawTurn[]; missing: string[] } {
  const view = segment(raw)
  const turnIds = new Set(raw.turns.map((t) => t.id))
  const segById = new Map(view.segments.map((s) => [s.id, s]))
  const missing: string[] = []
  const keepTurn = new Set<string>()
  for (const id of keepIds) {
    if (turnIds.has(id)) {
      keepTurn.add(id)
      continue
    }
    const seg = segById.get(id)
    if (seg !== undefined) {
      for (const ref of seg.raw_refs) keepTurn.add(ref)
      continue
    }
    missing.push(id)
  }
  const turns = raw.turns.filter((t) => keepTurn.has(t.id)).map(cloneTurn)
  return { turns, missing }
}

export function parseHumanKeepFile(text: string): Record<string, string[]> {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('human-keep 需要 JSON object：{ "<trace_id>": ["s0001", ...] }')
  }
  const row = parsed as Record<string, unknown>
  const source = isRecord(row.traces) ? row.traces : row
  const out: Record<string, string[]> = {}
  for (const [id, ids] of Object.entries(source)) {
    if (id === 'annotator' || id === 'date' || id === 'traces') continue
    if (!Array.isArray(ids)) {
      throw new Error(`human-keep ${id} 需要 string[] keep ids`)
    }
    const keepIds: string[] = []
    for (const item of ids) {
      if (typeof item !== 'string') {
        throw new Error(`human-keep ${id} 需要 string[] keep ids`)
      }
      keepIds.push(item)
    }
    out[id] = keepIds
  }
  return out
}

export function listTraceJsonl(inputPath: string): string[] {
  if (!existsSync(inputPath)) {
    throw new Error(`找不到输入: ${inputPath}`)
  }
  const st = statSync(inputPath)
  if (st.isFile()) return [inputPath]
  if (!st.isDirectory()) {
    throw new Error(`无法读取输入: ${inputPath}`)
  }
  return walkJsonl(inputPath)
}

export function loadAdmittedTrace(path: string): RawTrace {
  const text = readFileSync(path, 'utf8')
  if (!sniff(text)) {
    throw new AdmissionError('unparseable', '无法解析这条 Trace，拒绝入库')
  }
  return parse(text)
}

/**
 * Four-arm TrainingCut export (ADR-0013 §8). Writes manifest + per-arm turns/tokens.
 * Distilled arm calls existing `distill`; inject FakeSessionBackend in CLI when models unset.
 */
export async function exportUtilityArms(input: ExportUtilityInput): Promise<UtilityManifest> {
  const paths = listTraceJsonl(input.inputPath)
  const wanted = input.traceIds !== undefined ? new Set(input.traceIds) : undefined
  const admitted: RawTrace[] = []
  const skipped: UtilitySkip[] = []
  const seenWanted = new Set<string>()

  for (const path of paths) {
    try {
      const raw = loadAdmittedTrace(path)
      if (wanted !== undefined && !wanted.has(raw.meta.trace_id)) continue
      if (wanted !== undefined) seenWanted.add(raw.meta.trace_id)
      admitted.push(raw)
    } catch (error) {
      if (isAdmissionError(error)) {
        const skip: UtilitySkip = {
          trace_id: basename(path, '.jsonl'),
          reason: error.code,
          path,
        }
        skipped.push(skip)
        continue
      }
      throw error
    }
  }

  if (wanted !== undefined) {
    for (const id of wanted) {
      if (!seenWanted.has(id)) {
        skipped.push({ trace_id: id, reason: 'not_found' })
      }
    }
  }

  mkdirSync(input.outDir, { recursive: true })

  const skips: Partial<Record<UtilityArm, ArmSkipNote>> = {}
  const exported: string[] = []

  for (const arm of input.arms) {
    if (arm === 'human_curated' && input.humanKeepByTrace === undefined) {
      writeHumanCuratedStub(join(input.outDir, arm), 'no_human_keep')
      skips[arm] = { skipped: true, reason: 'no_human_keep' }
      continue
    }

    const armDir = join(input.outDir, arm)
    mkdirSync(armDir, { recursive: true })
    const tokens: UtilityArmTokens = {
      arm,
      traces: {},
      pool_tokens: 0,
      pool_turns: 0,
    }
    const thisSkips: UtilitySkip[] = []

    for (const raw of admitted) {
      try {
        const cut = await cutForArm(arm, raw, input)
        writeFileSync(
          join(armDir, `${sanitizeTraceId(raw.meta.trace_id)}.turns.json`),
          `${JSON.stringify(cut, null, 2)}\n`,
          'utf8',
        )
        const tok = sumTurnTokens(cut.turns)
        tokens.traces[raw.meta.trace_id] = {
          turn_count: cut.turns.length,
          tokens: tok,
        }
        tokens.pool_tokens += tok
        tokens.pool_turns += cut.turns.length
        if (!exported.includes(raw.meta.trace_id)) exported.push(raw.meta.trace_id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const skip: UtilitySkip = { trace_id: raw.meta.trace_id, reason, arm }
        thisSkips.push(skip)
      }
    }

    writeFileSync(join(armDir, 'tokens.json'), `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
    if (thisSkips.length > 0) skips[arm] = thisSkips
  }

  const manifest: UtilityManifest = {
    distiller_sha: input.distillerSha,
    profile_path: input.profilePath,
    profile_id: input.profile.id,
    arms: [...input.arms],
    trace_ids: { exported, skipped },
    token_metric: TOKEN_METRIC,
    skips,
    fake_l4: input.fakeL4,
  }
  writeFileSync(join(input.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function cutForArm(
  arm: UtilityArm,
  raw: RawTrace,
  input: ExportUtilityInput,
): Promise<TrainingCut> {
  if (arm === 'raw') {
    return wrapTrainingCut(raw.meta.trace_id, raw.turns, 'raw')
  }
  if (arm === 'tools_only') {
    return wrapTrainingCut(raw.meta.trace_id, filterToolsOnly(raw.turns), 'tools_only')
  }
  if (arm === 'human_curated') {
    const ids = input.humanKeepByTrace?.[raw.meta.trace_id]
    if (ids === undefined) {
      throw new Error('missing_human_keep_ids')
    }
    const { turns, missing } = filterByKeepIds(raw, ids)
    if (missing.length > 0) {
      throw new Error(`missing_keep_ids:${missing.join(',')}`)
    }
    return wrapTrainingCut(raw.meta.trace_id, turns, 'human_curated')
  }
  const mode = resolveDistillMode({})
  const result = await distill({ raw, profile: input.profile, mode })
  return {
    trace_id: result.training.trace_id,
    plan_ref: result.training.plan_ref,
    turns: result.training.turns.map(cloneTurn),
  }
}

function writeHumanCuratedStub(armDir: string, reason: string): void {
  mkdirSync(armDir, { recursive: true })
  writeFileSync(
    join(armDir, 'README.md'),
    [
      `# human_curated — skipped (${reason})`,
      '',
      'Pass `--human-keep <file>` with per-trace keep segment/turn ids.',
      'This arm does not fall back to raw.',
      '',
    ].join('\n'),
    'utf8',
  )
  const tokens: UtilityArmTokens = {
    arm: 'human_curated',
    traces: {},
    pool_tokens: 0,
    pool_turns: 0,
    skipped: true,
    skip_reason: reason,
  }
  writeFileSync(join(armDir, 'tokens.json'), `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

function walkJsonl(dir: string): string[] {
  const out: string[] = []
  const names = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const ent of names) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push(...walkJsonl(p))
      continue
    }
    if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

function sanitizeTraceId(traceId: string): string {
  const cleaned = traceId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'trace'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
