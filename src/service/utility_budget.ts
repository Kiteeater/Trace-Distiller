import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { choosePoolBudget, subsampleTraceIds } from '../eval/utility_budget.ts'
import { compressionRatio, distillRoi, sftTokensSaved } from '../eval/metrics.ts'
import { amortizedRoiScenarios, qualityGatedRoi, type QualityGatedRoi } from '../eval/utility_roi.ts'
import {
  TOKEN_METRIC,
  isUtilityArm,
  sanitizeTraceId,
  type UtilityArm,
  type UtilityArmTokens,
  type UtilityManifest,
} from './export_utility.ts'

export const REQUIRED_ALIGN_ARMS: readonly UtilityArm[] = ['raw', 'distilled', 'tools_only']
export const DEFAULT_BUDGETED_DIRNAME = 'budgeted'
export const BUDGET_ALIGN_ALGORITHM =
  'pool-level T=min(included non-skipped arm pool_tokens) or --budget N; greedy lex skip-and-continue; keep whole traces; never truncate mid-turns; no pad'
export const HANDOFF_NOTE = '本仓库不内置大模型训练循环；输出供外部 SFT'
export const UTILITY_REPORT_NOTE =
  'proxy_saved_trainingcut; not real SFT savings. 本仓库不内置大模型训练循环'

export interface UtilityHandoffArm {
  path: string
  pool_tokens: number
  trace_ids: string[]
  turn_files?: string[]
  skipped?: boolean
}

export interface UtilityHandoff {
  distiller_sha: string
  profile_path: string
  profile_id: string
  arms: UtilityArm[]
  per_arm: Partial<Record<UtilityArm, UtilityHandoffArm>>
  token_metric: typeof TOKEN_METRIC
  budget_tokens?: number
  fake_l4: boolean
  note: string
}

export interface UtilityReportArm {
  export_pool_tokens: number
  budgeted_pool_tokens?: number
  skipped?: boolean
}

export interface UtilityReport {
  note: string
  token_metric: typeof TOKEN_METRIC
  budget_tokens?: number
  arms: Partial<Record<UtilityArm, UtilityReportArm>>
  economics: {
    sft_tokens_saved: number
    distill_tokens: number | null
    roi: number | null
    compression_ratio: number | null
    key_step_recall: number | null
  }
  amortized_roi: { '1x1': number | null; '3x1': number | null; '3x3': number | null }
  quality_gated_roi: QualityGatedRoi
}

export interface BudgetedArmRow {
  trace_ids: string[]
  pool_tokens: number
  pool_turns: number
}

export interface BudgetedManifest {
  parent_export: string
  distiller_sha: string
  profile_path: string
  profile_id: string
  budget_tokens: number
  budget_source: 'min_arm_pool' | 'explicit'
  algorithm: string
  token_metric: typeof TOKEN_METRIC
  fake_l4: boolean
  arms: UtilityArm[]
  per_arm: Partial<Record<UtilityArm, BudgetedArmRow>>
}

export interface AlignUtilityBudgetInput {
  exportDir: string
  outDir?: string
  budget?: number
  key_step_recall?: number | null
  compression_ratio?: number | null
  distill_tokens?: number | null
  quality_ok?: boolean
}

export interface AlignUtilityBudgetResult {
  outDir: string
  budget_tokens: number
  manifest: BudgetedManifest
  handoff: UtilityHandoff
  report: UtilityReport
}

export interface FinalizeUtilityExportInput {
  exportDir: string
  alignBudget?: boolean
  budget?: number
  key_step_recall?: number | null
  compression_ratio?: number | null
  distill_tokens?: number | null
  quality_ok?: boolean
}

export interface FinalizeUtilityExportResult {
  handoff: UtilityHandoff
  report: UtilityReport
  aligned?: AlignUtilityBudgetResult
}

export function finalizeUtilityExport(input: FinalizeUtilityExportInput): FinalizeUtilityExportResult {
  const parent = loadExportManifest(input.exportDir)
  const exportArms = loadExportArmTokens(input.exportDir, parent.arms)
  const handoff = buildHandoff({
    manifest: parent,
    armTokens: exportArms,
  })
  writeJson(join(input.exportDir, 'handoff.json'), handoff)
  const report = buildUtilityReport({
    exportArms,
    manifest: parent,
    ...optionalReportGates(input),
  })
  writeUtilityReportFiles(input.exportDir, report)

  if (input.alignBudget !== true && input.budget === undefined) {
    return { handoff, report }
  }

  const aligned = alignUtilityBudget({
    exportDir: input.exportDir,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.key_step_recall !== undefined ? { key_step_recall: input.key_step_recall } : {}),
    ...(input.compression_ratio !== undefined ? { compression_ratio: input.compression_ratio } : {}),
    ...(input.distill_tokens !== undefined ? { distill_tokens: input.distill_tokens } : {}),
    ...(input.quality_ok !== undefined ? { quality_ok: input.quality_ok } : {}),
  })
  writeUtilityReportFiles(input.exportDir, aligned.report)
  return { handoff: aligned.handoff, report: aligned.report, aligned }
}

export function alignUtilityBudget(input: AlignUtilityBudgetInput): AlignUtilityBudgetResult {
  const exportDir = input.exportDir
  const parent = loadExportManifest(exportDir)
  const loaded = loadExportArmTokens(exportDir, parent.arms)
  const included = includedAlignArms(loaded)
  const poolMap: Record<string, number> = {}
  for (const arm of included) {
    poolMap[arm] = loaded[arm]!.pool_tokens
  }
  const budgetSource: BudgetedManifest['budget_source'] =
    input.budget !== undefined ? 'explicit' : 'min_arm_pool'
  const budget = input.budget !== undefined ? input.budget : choosePoolBudget(poolMap)
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error(`invalid budget ${String(input.budget)}`)
  }

  const outDir = input.outDir ?? join(exportDir, DEFAULT_BUDGETED_DIRNAME)
  mkdirSync(outDir, { recursive: true })

  const per_arm: Partial<Record<UtilityArm, BudgetedArmRow>> = {}
  const budgetedTokens: Partial<Record<UtilityArm, UtilityArmTokens>> = {}

  for (const arm of included) {
    const src = loaded[arm]!
    const { selected, pool_tokens } = subsampleTraceIds(src.traces, budget)
    const traces: UtilityArmTokens['traces'] = {}
    let pool_turns = 0
    let hole = 0
    let holeSeen = false
    for (const id of selected) {
      const row = src.traces[id]
      if (row === undefined) continue
      traces[id] = row
      pool_turns += row.turn_count
      if (row.hole_a_plus_b_tokens !== undefined) {
        hole += row.hole_a_plus_b_tokens
        holeSeen = true
      }
    }
    const tokens: UtilityArmTokens = {
      arm,
      traces,
      pool_tokens,
      pool_turns,
    }
    if (holeSeen) {
      tokens.hole_a_plus_b_tokens = hole
    } else if (src.hole_a_plus_b_tokens !== undefined) {
      tokens.hole_a_plus_b_tokens = src.hole_a_plus_b_tokens
    }
    const armDir = join(outDir, arm)
    mkdirSync(armDir, { recursive: true })
    writeJson(join(armDir, 'tokens.json'), tokens)
    writeJson(join(armDir, 'selected_trace_ids.json'), selected)
    for (const id of selected) {
      const name = `${sanitizeTraceId(id)}.turns.json`
      const srcPath = join(exportDir, arm, name)
      if (!existsSync(srcPath)) {
        throw new Error(`missing turns file for ${arm}/${id}: ${srcPath}`)
      }
      copyFileSync(srcPath, join(armDir, name))
    }
    per_arm[arm] = { trace_ids: selected, pool_tokens, pool_turns }
    budgetedTokens[arm] = tokens
  }

  const manifest: BudgetedManifest = {
    parent_export: exportDir,
    distiller_sha: parent.distiller_sha,
    profile_path: parent.profile_path,
    profile_id: parent.profile_id,
    budget_tokens: budget,
    budget_source: budgetSource,
    algorithm: BUDGET_ALIGN_ALGORITHM,
    token_metric: TOKEN_METRIC,
    fake_l4: parent.fake_l4,
    arms: included,
    per_arm,
  }
  writeJson(join(outDir, 'manifest.json'), manifest)

  const handoff = buildHandoff({
    manifest: parent,
    armTokens: budgetedTokens,
    arms: included,
    budget_tokens: budget,
  })
  writeJson(join(outDir, 'handoff.json'), handoff)

  const report = buildUtilityReport({
    exportArms: loaded,
    budgetedArms: budgetedTokens,
    manifest: parent,
    budget_tokens: budget,
    ...optionalReportGates(input),
  })
  writeUtilityReportFiles(outDir, report)

  return { outDir, budget_tokens: budget, manifest, handoff, report }
}

export function loadExportManifest(exportDir: string): UtilityManifest {
  const path = join(exportDir, 'manifest.json')
  if (!existsSync(path)) {
    throw new Error(`找不到 export manifest: ${path}`)
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`无效 export manifest: ${path}`)
  }
  return parsed as UtilityManifest
}

export function loadExportArmTokens(
  exportDir: string,
  arms: readonly UtilityArm[],
): Partial<Record<UtilityArm, UtilityArmTokens>> {
  const out: Partial<Record<UtilityArm, UtilityArmTokens>> = {}
  for (const arm of arms) {
    const path = join(exportDir, arm, 'tokens.json')
    if (!existsSync(path)) {
      if (REQUIRED_ALIGN_ARMS.includes(arm)) {
        throw new Error(`缺少对齐所需臂 ${arm}/tokens.json`)
      }
      continue
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`无效 tokens.json: ${path}`)
    }
    out[arm] = parsed as UtilityArmTokens
  }
  return out
}

function includedAlignArms(
  loaded: Partial<Record<UtilityArm, UtilityArmTokens>>,
): UtilityArm[] {
  for (const arm of REQUIRED_ALIGN_ARMS) {
    const row = loaded[arm]
    if (row === undefined || row.skipped === true) {
      throw new Error(`对齐需要臂 ${arm}（未跳过）`)
    }
  }
  const arms: UtilityArm[] = [...REQUIRED_ALIGN_ARMS]
  const human = loaded.human_curated
  if (human !== undefined && human.skipped !== true) {
    arms.push('human_curated')
  }
  return arms
}

function buildHandoff(input: {
  manifest: UtilityManifest
  armTokens: Partial<Record<UtilityArm, UtilityArmTokens>>
  arms?: readonly UtilityArm[]
  budget_tokens?: number
}): UtilityHandoff {
  const arms = input.arms !== undefined ? [...input.arms] : [...input.manifest.arms]
  const per_arm: Partial<Record<UtilityArm, UtilityHandoffArm>> = {}
  for (const arm of arms) {
    if (!isUtilityArm(arm)) continue
    const tokens = input.armTokens[arm]
    const skipped = tokens?.skipped === true
    const trace_ids = tokens !== undefined ? Object.keys(tokens.traces).sort(lex) : []
    const turn_files = skipped
      ? []
      : trace_ids.map((id) => join(arm, `${sanitizeTraceId(id)}.turns.json`))
    const row: UtilityHandoffArm = {
      path: arm,
      pool_tokens: tokens?.pool_tokens ?? 0,
      trace_ids,
    }
    if (turn_files.length > 0) row.turn_files = turn_files
    if (skipped) row.skipped = true
    per_arm[arm] = row
  }
  const handoff: UtilityHandoff = {
    distiller_sha: input.manifest.distiller_sha,
    profile_path: input.manifest.profile_path,
    profile_id: input.manifest.profile_id,
    arms,
    per_arm,
    token_metric: TOKEN_METRIC,
    fake_l4: input.manifest.fake_l4,
    note: HANDOFF_NOTE,
  }
  if (input.budget_tokens !== undefined) handoff.budget_tokens = input.budget_tokens
  return handoff
}

export function buildUtilityReport(input: {
  exportArms: Partial<Record<UtilityArm, UtilityArmTokens>>
  budgetedArms?: Partial<Record<UtilityArm, UtilityArmTokens>>
  manifest: UtilityManifest
  budget_tokens?: number
  key_step_recall?: number | null
  compression_ratio?: number | null
  distill_tokens?: number | null
  quality_ok?: boolean
}): UtilityReport {
  const armNames = new Set<UtilityArm>([
    ...input.manifest.arms,
    ...(input.budgetedArms !== undefined ? (Object.keys(input.budgetedArms) as UtilityArm[]) : []),
  ])
  const arms: Partial<Record<UtilityArm, UtilityReportArm>> = {}
  for (const arm of armNames) {
    const exported = input.exportArms[arm]
    const budgeted = input.budgetedArms?.[arm]
    const row: UtilityReportArm = {
      export_pool_tokens: exported?.pool_tokens ?? 0,
    }
    if (budgeted !== undefined) row.budgeted_pool_tokens = budgeted.pool_tokens
    if (exported?.skipped === true) row.skipped = true
    arms[arm] = row
  }

  const rawPool = input.exportArms.raw?.pool_tokens ?? 0
  const distilledPool = input.exportArms.distilled?.pool_tokens ?? 0
  const sft_tokens_saved = sftTokensSaved({
    original_tokens: rawPool,
    training_cut_tokens: distilledPool,
  })
  const compression_ratio =
    input.compression_ratio !== undefined
      ? input.compression_ratio
      : rawPool > 0
        ? compressionRatio({ original_tokens: rawPool, cut_tokens: distilledPool })
        : null
  const distill_tokens =
    input.distill_tokens !== undefined
      ? input.distill_tokens
      : (input.exportArms.distilled?.hole_a_plus_b_tokens ?? null)
  const spent = distill_tokens ?? 0
  const roi =
    distill_tokens === null
      ? null
      : distillRoi({ hole_a_plus_b_tokens: spent, sft_tokens_saved })
  const key_step_recall = input.key_step_recall ?? null
  const gated = qualityGatedRoi({
    roi,
    key_step_recall,
    compression_ratio,
    ...(input.quality_ok !== undefined ? { quality_ok: input.quality_ok } : {}),
  })

  const report: UtilityReport = {
    note: UTILITY_REPORT_NOTE,
    token_metric: TOKEN_METRIC,
    arms,
    economics: {
      sft_tokens_saved,
      distill_tokens,
      roi,
      compression_ratio,
      key_step_recall,
    },
    amortized_roi: amortizedRoiScenarios(gated.quality_ok ? roi : null),
    quality_gated_roi: gated,
  }
  if (input.budget_tokens !== undefined) report.budget_tokens = input.budget_tokens
  return report
}

function writeUtilityReportFiles(dir: string, report: UtilityReport): void {
  writeJson(join(dir, 'utility-report.json'), report)
  writeFileSync(join(dir, 'utility-report.md'), renderUtilityReportMarkdown(report), 'utf8')
}

export function renderUtilityReportMarkdown(report: UtilityReport): string {
  const lines: string[] = [
    '# Training-utility report (ADR-0013 P0)',
    '',
    report.note,
    '',
    `- token_metric: \`${report.token_metric}\``,
  ]
  if (report.budget_tokens !== undefined) {
    lines.push(`- budget_tokens T: ${String(report.budget_tokens)}`)
  }
  lines.push('')
  lines.push('| arm | export_pool_tokens | budgeted_pool_tokens |')
  lines.push('|---|---:|---:|')
  for (const [arm, row] of Object.entries(report.arms)) {
    if (row === undefined) continue
    const bud = row.budgeted_pool_tokens === undefined ? '—' : String(row.budgeted_pool_tokens)
    const skip = row.skipped === true ? ' (skipped)' : ''
    lines.push(`| ${arm}${skip} | ${String(row.export_pool_tokens)} | ${bud} |`)
  }
  lines.push('')
  lines.push('## Economics (proxy_saved_trainingcut / spend_AB)')
  lines.push('')
  lines.push(`- sft_tokens_saved: ${String(report.economics.sft_tokens_saved)}`)
  lines.push(`- distill_tokens: ${fmtNull(report.economics.distill_tokens)}`)
  lines.push(`- roi (1×1, ungated): ${fmtNull(report.economics.roi)}`)
  lines.push(`- compression_ratio: ${fmtNull(report.economics.compression_ratio)}`)
  lines.push(`- key_step_recall: ${fmtNull(report.economics.key_step_recall)}`)
  lines.push('')
  lines.push('## Amortized ROI (students × epochs)')
  lines.push('')
  lines.push(`- 1×1: ${fmtNull(report.amortized_roi['1x1'])}`)
  lines.push(`- 3×1: ${fmtNull(report.amortized_roi['3x1'])}`)
  lines.push(`- 3×3: ${fmtNull(report.amortized_roi['3x3'])}`)
  lines.push('')
  lines.push('## Quality-gated ROI')
  lines.push('')
  lines.push(`- quality_ok: ${String(report.quality_gated_roi.quality_ok)}`)
  lines.push(`- roi: ${fmtNull(report.quality_gated_roi.roi)}`)
  if (report.quality_gated_roi.reason !== undefined) {
    lines.push(`- reason: ${report.quality_gated_roi.reason}`)
  }
  lines.push('')
  lines.push('本仓库不内置大模型训练循环。Amortized numbers use quality-gated ROI (null when gates fail).')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function optionalReportGates(input: {
  key_step_recall?: number | null
  compression_ratio?: number | null
  distill_tokens?: number | null
  quality_ok?: boolean
}): {
  key_step_recall?: number | null
  compression_ratio?: number | null
  distill_tokens?: number | null
  quality_ok?: boolean
} {
  return {
    ...(input.key_step_recall !== undefined ? { key_step_recall: input.key_step_recall } : {}),
    ...(input.compression_ratio !== undefined ? { compression_ratio: input.compression_ratio } : {}),
    ...(input.distill_tokens !== undefined ? { distill_tokens: input.distill_tokens } : {}),
    ...(input.quality_ok !== undefined ? { quality_ok: input.quality_ok } : {}),
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function fmtNull(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return String(n)
}

function lex(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
