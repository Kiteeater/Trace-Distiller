import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { FakeSessionBackend, setSessionBackend } from '../../src/agent/sessions/open_session.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { EXIT_OK, parseArgv, runCli } from '../../src/service/cli.ts'
import {
  DEFAULT_UTILITY_OUT_DIR,
  TOKEN_METRIC,
  exportUtilityArms,
  filterByKeepIds,
  parseHumanKeepFile,
  parseUtilityArms,
} from '../../src/service/export_utility.ts'
import { resetLiveState } from '../../src/service/live.ts'
import type { TrainingCut } from '../../src/types/cut_plan.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')
const pytestJsonl = join(fixtures, 'single_task_pytest.jsonl')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'distiller-utility-'))
}

describe('export-utility', { concurrency: 1 }, () => {
  afterEach(() => {
    setSessionBackend(undefined)
    resetLiveState()
  })

  it('parseArgv reads export-utility flags', () => {
    const args = parseArgv([
      'export-utility',
      'a.jsonl',
      '--out-dir',
      'benchmark/out-utility',
      '--arms',
      'raw,tools_only,human_curated',
      '--fake-l4',
      '--profile',
      'p.json',
      '--human-keep',
      'keep.json',
      '--trace-ids',
      'id1,id2',
    ])
    assert.equal(args.command, 'export-utility')
    assert.equal(args.input_path, 'a.jsonl')
    assert.equal(args.out_dir, 'benchmark/out-utility')
    assert.deepEqual(args.arms, ['raw', 'tools_only', 'human_curated'])
    assert.equal(args.fake_l4, true)
    assert.equal(args.profile_path, 'p.json')
    assert.equal(args.human_keep_path, 'keep.json')
    assert.deepEqual(args.trace_ids, ['id1', 'id2'])
  })

  it('parseUtilityArms rejects unknown arms', () => {
    assert.throws(
      () => parseUtilityArms('raw,sft'),
      (err: unknown) => err instanceof Error && err.message.includes('未知 arm sft'),
    )
  })

  it('writes raw + tools_only + distilled layout with Fake; stubs human_curated', async () => {
    const outDir = tmp()
    const code = await runCli({
      command: 'export-utility',
      input_path: pytestJsonl,
      out_dir: outDir,
      fake_l4: true,
      arms: ['raw', 'distilled', 'tools_only', 'human_curated'],
    })
    assert.equal(code, EXIT_OK)

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      distiller_sha: string
      profile_path: string
      profile_id: string
      arms: string[]
      trace_ids: { exported: string[]; skipped: unknown[] }
      token_metric: string
      skips: { human_curated?: { skipped: boolean; reason: string } }
      fake_l4: boolean
    }
    assert.equal(manifest.token_metric, TOKEN_METRIC)
    assert.equal(manifest.profile_id, DEFAULT_CUT_PROFILE.id)
    assert.equal(manifest.profile_path, 'src/constant/compression.ts')
    assert.ok(manifest.distiller_sha.length > 0)
    assert.notEqual(manifest.distiller_sha, '')
    assert.equal(manifest.fake_l4, true)
    assert.deepEqual(manifest.arms, ['raw', 'distilled', 'tools_only', 'human_curated'])
    assert.ok(manifest.trace_ids.exported.length >= 1)
    assert.equal(manifest.skips.human_curated?.skipped, true)
    assert.equal(manifest.skips.human_curated?.reason, 'no_human_keep')

    const raw = parse(readFileSync(pytestJsonl, 'utf8'))
    const stem = raw.meta.trace_id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

    for (const arm of ['raw', 'tools_only', 'distilled'] as const) {
      const cutPath = join(outDir, arm, `${stem}.turns.json`)
      const cut = JSON.parse(readFileSync(cutPath, 'utf8')) as TrainingCut
      assert.equal(cut.trace_id, raw.meta.trace_id)
      assert.ok(Array.isArray(cut.turns))
      assert.ok(cut.turns.length > 0)
      const tokens = JSON.parse(readFileSync(join(outDir, arm, 'tokens.json'), 'utf8')) as {
        arm: string
        pool_tokens: number
        pool_turns: number
        traces: Record<string, { turn_count: number; tokens: number }>
      }
      assert.equal(tokens.arm, arm)
      assert.ok(tokens.pool_tokens > 0)
      assert.ok(tokens.pool_turns > 0)
      assert.ok(tokens.traces[raw.meta.trace_id]?.tokens === tokens.pool_tokens)
    }

    const rawCut = JSON.parse(
      readFileSync(join(outDir, 'raw', `${stem}.turns.json`), 'utf8'),
    ) as TrainingCut
    assert.equal(rawCut.plan_ref, 'raw')
    assert.equal(rawCut.turns.length, raw.turns.length)

    const toolsCut = JSON.parse(
      readFileSync(join(outDir, 'tools_only', `${stem}.turns.json`), 'utf8'),
    ) as TrainingCut
    assert.equal(toolsCut.plan_ref, 'tools_only')
    assert.ok(toolsCut.turns.length < raw.turns.length)
    assert.equal(toolsCut.turns[0]?.role, 'user')

    const distilledCut = JSON.parse(
      readFileSync(join(outDir, 'distilled', `${stem}.turns.json`), 'utf8'),
    ) as TrainingCut
    assert.ok(distilledCut.plan_ref.length > 0)
    assert.notEqual(distilledCut.plan_ref, 'raw')

    const humanNames = readdirSync(join(outDir, 'human_curated'))
    assert.ok(humanNames.includes('README.md'))
    assert.ok(humanNames.includes('tokens.json'))
    assert.ok(!humanNames.some((n) => n.endsWith('.turns.json')))
    const humanTokens = JSON.parse(
      readFileSync(join(outDir, 'human_curated', 'tokens.json'), 'utf8'),
    ) as { skipped?: boolean; pool_tokens: number }
    assert.equal(humanTokens.skipped, true)
    assert.equal(humanTokens.pool_tokens, 0)
    const humanReadme = readFileSync(join(outDir, 'human_curated', 'README.md'), 'utf8')
    assert.match(humanReadme, /does not fall back to raw/)
  })

  it('human_curated missing keep ids fail that trace and do not write raw', async () => {
    const outDir = tmp()
    const keepPath = join(outDir, 'keep.json')
    const raw = parse(readFileSync(pytestJsonl, 'utf8'))
    writeFileSync(keepPath, JSON.stringify({ [raw.meta.trace_id]: ['s9999'] }), 'utf8')
    setSessionBackend(new FakeSessionBackend())
    const manifest = await exportUtilityArms({
      inputPath: pytestJsonl,
      outDir,
      arms: ['human_curated'],
      profile: DEFAULT_CUT_PROFILE,
      profilePath: 'src/constant/compression.ts',
      distillerSha: 'test-sha',
      fakeL4: true,
      humanKeepByTrace: parseHumanKeepFile(readFileSync(keepPath, 'utf8')),
    })
    const skips = manifest.skips.human_curated
    assert.ok(Array.isArray(skips))
    assert.equal(skips[0]?.trace_id, raw.meta.trace_id)
    assert.match(skips[0]?.reason ?? '', /missing_keep_ids/)
    const names = readdirSync(join(outDir, 'human_curated'))
    assert.ok(!names.some((n) => n.endsWith('.turns.json')))
    const tokens = JSON.parse(
      readFileSync(join(outDir, 'human_curated', 'tokens.json'), 'utf8'),
    ) as { pool_tokens: number; traces: Record<string, unknown> }
    assert.equal(tokens.pool_tokens, 0)
    assert.deepEqual(tokens.traces, {})
  })

  it('human_curated keep ids project matching RawTurns in original order', () => {
    const raw = parse(readFileSync(pytestJsonl, 'utf8'))
    const { turns, missing } = filterByKeepIds(raw, ['s0001', 's0002'])
    assert.deepEqual(missing, [])
    assert.ok(turns.length > 0)
    const rawIndex = new Map(raw.turns.map((t, i) => [t.id, i]))
    for (let i = 1; i < turns.length; i += 1) {
      const prev = rawIndex.get(turns[i - 1]!.id) ?? -1
      const cur = rawIndex.get(turns[i]!.id) ?? -1
      assert.ok(prev < cur)
    }
    const firstUser = raw.turns.find((t) => t.role === 'user')
    assert.equal(turns[0]?.id, firstUser?.id)
  })

  it('default out-dir constant matches the CLI default', () => {
    assert.equal(DEFAULT_UTILITY_OUT_DIR, join('benchmark', 'out-utility'))
  })
})
