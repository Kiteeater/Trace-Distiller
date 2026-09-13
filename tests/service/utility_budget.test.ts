import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { TOKEN_METRIC } from '../../src/service/export_utility.ts'
import { parseArgv } from '../../src/service/cli.ts'
import {
  DEFAULT_BUDGETED_DIRNAME,
  HANDOFF_NOTE,
  alignUtilityBudget,
  finalizeUtilityExport,
} from '../../src/service/utility_budget.ts'
import type { UtilityArmTokens, UtilityManifest } from '../../src/service/export_utility.ts'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'distiller-budget-'))
}

function writeArm(
  exportDir: string,
  arm: string,
  traces: Record<string, { tokens: number; turn_count?: number; hole_a_plus_b_tokens?: number }>,
): void {
  const armDir = join(exportDir, arm)
  mkdirSync(armDir, { recursive: true })
  const row: UtilityArmTokens = {
    arm: arm as UtilityArmTokens['arm'],
    traces: {},
    pool_tokens: 0,
    pool_turns: 0,
  }
  for (const [id, t] of Object.entries(traces)) {
    const turn_count = t.turn_count ?? 1
    row.traces[id] = { turn_count, tokens: t.tokens }
    if (t.hole_a_plus_b_tokens !== undefined) {
      row.traces[id]!.hole_a_plus_b_tokens = t.hole_a_plus_b_tokens
      row.hole_a_plus_b_tokens = (row.hole_a_plus_b_tokens ?? 0) + t.hole_a_plus_b_tokens
    }
    row.pool_tokens += t.tokens
    row.pool_turns += turn_count
    writeFileSync(
      join(armDir, `${id}.turns.json`),
      `${JSON.stringify({ trace_id: id, plan_ref: arm, turns: [{ id: `${id}-t0`, tokens: t.tokens }] }, null, 2)}\n`,
      'utf8',
    )
  }
  writeFileSync(join(armDir, 'tokens.json'), `${JSON.stringify(row, null, 2)}\n`, 'utf8')
}

function seedExport(exportDir: string): void {
  mkdirSync(exportDir, { recursive: true })
  const manifest: UtilityManifest = {
    distiller_sha: 'test-sha',
    profile_path: 'src/constant/compression.ts',
    profile_id: 'default',
    arms: ['raw', 'distilled', 'tools_only'],
    trace_ids: { exported: ['a', 'b', 'c', 'd'], skipped: [] },
    token_metric: TOKEN_METRIC,
    skips: {},
    fake_l4: true,
  }
  writeFileSync(join(exportDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeArm(exportDir, 'raw', { a: { tokens: 8 }, b: { tokens: 50 }, c: { tokens: 9 }, d: { tokens: 7 } })
  writeArm(exportDir, 'distilled', {
    a: { tokens: 5, hole_a_plus_b_tokens: 2 },
    b: { tokens: 10, hole_a_plus_b_tokens: 2 },
    c: { tokens: 5, hole_a_plus_b_tokens: 2 },
    d: { tokens: 5, hole_a_plus_b_tokens: 2 },
  })
  writeArm(exportDir, 'tools_only', { a: { tokens: 6 }, b: { tokens: 20 }, c: { tokens: 6 }, d: { tokens: 6 } })
}

describe('alignUtilityBudget IO', () => {
  it('writes budgeted/ with T=min, skip-and-continue, and handoff', () => {
    const exportDir = tmp()
    seedExport(exportDir)
    const result = alignUtilityBudget({ exportDir })
    assert.equal(result.budget_tokens, 25)
    assert.equal(result.outDir, join(exportDir, DEFAULT_BUDGETED_DIRNAME))
    assert.equal(result.manifest.budget_source, 'min_arm_pool')
    assert.match(result.manifest.algorithm, /skip-and-continue/)
    assert.equal(result.manifest.distiller_sha, 'test-sha')
    assert.equal(result.manifest.profile_id, 'default')

    assert.deepEqual(result.manifest.per_arm.distilled?.trace_ids, ['a', 'b', 'c', 'd'])
    assert.equal(result.manifest.per_arm.distilled?.pool_tokens, 25)

    assert.deepEqual(result.manifest.per_arm.raw?.trace_ids, ['a', 'c', 'd'])
    assert.equal(result.manifest.per_arm.raw?.pool_tokens, 24)

    assert.deepEqual(result.manifest.per_arm.tools_only?.trace_ids, ['a', 'c', 'd'])
    assert.equal(result.manifest.per_arm.tools_only?.pool_tokens, 18)

    const rawSelected = JSON.parse(
      readFileSync(join(result.outDir, 'raw', 'selected_trace_ids.json'), 'utf8'),
    ) as string[]
    assert.deepEqual(rawSelected, ['a', 'c', 'd'])
    const rawTokens = JSON.parse(
      readFileSync(join(result.outDir, 'raw', 'tokens.json'), 'utf8'),
    ) as { pool_tokens: number; traces: Record<string, unknown> }
    assert.equal(rawTokens.pool_tokens, 24)
    assert.deepEqual(Object.keys(rawTokens.traces).sort(), ['a', 'c', 'd'])
    readFileSync(join(result.outDir, 'raw', 'a.turns.json'), 'utf8')
    readFileSync(join(result.outDir, 'raw', 'c.turns.json'), 'utf8')

    const handoff = JSON.parse(readFileSync(join(result.outDir, 'handoff.json'), 'utf8')) as {
      distiller_sha: string
      profile_path: string
      profile_id: string
      arms: string[]
      per_arm: Record<string, { path: string; pool_tokens: number; trace_ids: string[]; turn_files?: string[] }>
      token_metric: string
      budget_tokens: number
      fake_l4: boolean
      note: string
    }
    assert.equal(handoff.distiller_sha, 'test-sha')
    assert.equal(handoff.profile_path, 'src/constant/compression.ts')
    assert.equal(handoff.profile_id, 'default')
    assert.equal(handoff.token_metric, TOKEN_METRIC)
    assert.equal(handoff.budget_tokens, 25)
    assert.equal(handoff.fake_l4, true)
    assert.equal(handoff.note, HANDOFF_NOTE)
    assert.match(handoff.note, /本仓库不内置大模型训练循环/)
    assert.ok(handoff.per_arm.raw?.turn_files?.includes('raw/a.turns.json'))

    const report = JSON.parse(readFileSync(join(result.outDir, 'utility-report.json'), 'utf8')) as {
      note: string
      amortized_roi: { '1x1': number | null; '3x1': number | null; '3x3': number | null }
      quality_gated_roi: { roi: number | null; quality_ok: boolean; reason?: string }
      economics: { sft_tokens_saved: number; roi: number | null }
    }
    assert.match(report.note, /proxy_saved_trainingcut/)
    assert.match(report.note, /本仓库不内置大模型训练循环/)
    assert.equal(report.economics.sft_tokens_saved, 49)
    assert.deepEqual(Object.keys(report.amortized_roi).sort(), ['1x1', '3x1', '3x3'])
    assert.equal(report.quality_gated_roi.quality_ok, false)
    assert.equal(report.quality_gated_roi.roi, null)
  })

  it('explicit --budget N overrides min', () => {
    const exportDir = tmp()
    seedExport(exportDir)
    const result = alignUtilityBudget({ exportDir, budget: 15 })
    assert.equal(result.budget_tokens, 15)
    assert.equal(result.manifest.budget_source, 'explicit')
    // a=8 keep, b=50 skip, c=9 would be 17>15 skip, d=7 keep → 15
    assert.deepEqual(result.manifest.per_arm.raw?.trace_ids, ['a', 'd'])
    assert.equal(result.manifest.per_arm.raw?.pool_tokens, 15)
  })

  it('finalizeUtilityExport writes handoff without align; align adds budgeted/', () => {
    const exportDir = tmp()
    seedExport(exportDir)
    const plain = finalizeUtilityExport({ exportDir })
    assert.equal(plain.aligned, undefined)
    const handoff = JSON.parse(readFileSync(join(exportDir, 'handoff.json'), 'utf8')) as {
      budget_tokens?: number
      note: string
    }
    assert.equal(handoff.budget_tokens, undefined)
    assert.match(handoff.note, /本仓库不内置大模型训练循环/)
    readFileSync(join(exportDir, 'utility-report.json'), 'utf8')

    const aligned = finalizeUtilityExport({ exportDir, alignBudget: true })
    assert.ok(aligned.aligned !== undefined)
    readFileSync(join(exportDir, DEFAULT_BUDGETED_DIRNAME, 'manifest.json'), 'utf8')
  })
})

describe('parseArgv export-utility --align-budget', () => {
  it('reads --align-budget and --budget N', () => {
    const args = parseArgv([
      'export-utility',
      'a.jsonl',
      '--fake-l4',
      '--align-budget',
      '--budget',
      '12000',
    ])
    assert.equal(args.command, 'export-utility')
    assert.equal(args.align_budget, true)
    assert.equal(args.budget, 12000)
  })

  it('--budget implies align-budget', () => {
    const args = parseArgv(['export-utility', 'a.jsonl', '--budget', '1'])
    assert.equal(args.align_budget, true)
    assert.equal(args.budget, 1)
  })
})
