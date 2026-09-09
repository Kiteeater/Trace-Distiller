import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDb, getTraceMeta, listSegments } from '../../src/data/data_segment.ts'
import { ruleCoverage } from '../../src/data/data_label.ts'
import { FakeSessionBackend, setSessionBackend } from '../../src/agent/sessions/open_session.ts'
import { SKELETON_PASS_JSON_KIND } from '../../src/agent/sessions/skeleton_pass.ts'
import { EXIT_ADMISSION, EXIT_OK, parseArgv, runCli } from '../../src/service/cli.ts'
import { get_cut_progress, list_jobs, resetLiveState } from '../../src/service/live.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const fixtures = join(here, '../fixtures/claude_code')
const cliSrc = join(here, '../../src/service/cli.ts')
const scriptSrc = join(here, '../../script/run-distill.ts')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'distiller-cli-'))
}

describe('cli', () => {
  afterEach(() => {
    setSessionBackend(undefined)
    resetLiveState()
  })

  it('does not import pi, createAgentSession, or listen', () => {
    const src = readFileSync(cliSrc, 'utf8')
    const script = readFileSync(scriptSrc, 'utf8')
    for (const text of [src, script]) {
      assert.doesNotMatch(text, /@mariozechner\/pi/)
      assert.doesNotMatch(text, /createAgentSession/)
      assert.doesNotMatch(text, /from ['"]pi['"]/)
      assert.doesNotMatch(text, /\.listen\s*\(/)
      assert.doesNotMatch(text, /createServer/)
    }
  })

  it('parseArgv reads distill flags', () => {
    const args = parseArgv([
      'distill',
      'a.jsonl',
      '--profile',
      'p.json',
      '--sqlite',
      'db.sqlite',
      '--out-dir',
      'out',
      '--report',
      'r.html',
      '--no-llm',
    ])
    assert.equal(args.command, 'distill')
    assert.equal(args.input_path, 'a.jsonl')
    assert.equal(args.profile_path, 'p.json')
    assert.equal(args.sqlite_path, 'db.sqlite')
    assert.equal(args.out_dir, 'out')
    assert.equal(args.report_path, 'r.html')
    assert.equal(args.no_llm, true)
  })

  it('writes training/playback json for --no-llm fixture and exits 0', async () => {
    resetLiveState()
    const outDir = tmp()
    const sqlite = join(outDir, 'distiller.sqlite')
    const report = join(outDir, 'report.html')
    const code = await runCli({
      command: 'distill',
      input_path: join(fixtures, 'no_llm_conservative.jsonl'),
      out_dir: outDir,
      sqlite_path: sqlite,
      report_path: report,
      no_llm: true,
    })
    assert.equal(code, EXIT_OK)

    const names = readdirSync(outDir)
    const training = names.find((n) => n.endsWith('-training.json'))
    const playback = names.find((n) => n.endsWith('-playback.json'))
    assert.ok(training, `training missing in ${names.join(',')}`)
    assert.ok(playback, `playback missing in ${names.join(',')}`)
    const trainingJson = JSON.parse(readFileSync(join(outDir, training), 'utf8')) as {
      trace_id: string
      turns: unknown[]
    }
    const playbackJson = JSON.parse(readFileSync(join(outDir, playback), 'utf8')) as {
      trace_id: string
      cards: unknown[]
    }
    assert.equal(trainingJson.trace_id, playbackJson.trace_id)
    assert.ok(trainingJson.turns.length > 0)
    assert.ok(playbackJson.cards.length > 0)

    const html = readFileSync(report, 'utf8')
    assert.match(html, /data-compression-ratio=/)
    assert.match(html, /id="hero"/)

    const db = openDb(sqlite)
    try {
      const meta = getTraceMeta(db, trainingJson.trace_id)
      assert.equal(meta?.trace_id, trainingJson.trace_id)
      assert.ok((listSegments(db, trainingJson.trace_id).length ?? 0) > 0)
      const cov = ruleCoverage(db, trainingJson.trace_id)
      assert.ok(cov.total > 0)
      assert.ok(cov.ruled > 0)
    } finally {
      db.close()
    }

    const jobs = list_jobs()
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]?.trace_id, trainingJson.trace_id)
    assert.equal(jobs[0]?.status, 'done')
    assert.equal(jobs[0]?.attached, false)
  })

  it('prints 人话 and exits 2 on no Ground Truth; writes no distilled files', async () => {
    const outDir = tmp()
    const errors: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write
    try {
      const code = await runCli({
        command: 'distill',
        input_path: join(fixtures, 'no_gt_verbal_ok.jsonl'),
        out_dir: outDir,
        no_llm: true,
      })
      assert.equal(code, EXIT_ADMISSION)
    } finally {
      process.stderr.write = origWrite
    }
    assert.match(errors.join(''), /无 Ground Truth，拒绝入库/)
    assert.equal(
      readdirSync(outDir).filter((n) => n.endsWith('.json')).length,
      0,
    )
  })

  it('script entry exits 0 on the synthetic fixture', () => {
    const outDir = tmp()
    const result = spawnSync(
      process.execPath,
      [
        scriptSrc,
        'distill',
        join(fixtures, 'no_llm_conservative.jsonl'),
        '--no-llm',
        '--out-dir',
        outDir,
      ],
      { encoding: 'utf8', cwd: repoRoot },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(outDir, 'claude-code-sess-no-llm-training.json')), true)
    assert.equal(existsSync(join(outDir, 'claude-code-sess-no-llm-playback.json')), true)
  })

  it('without --no-llm and without backend/env falls back to no_llm', async () => {
    const outDir = tmp()
    const code = await runCli({
      command: 'distill',
      input_path: join(fixtures, 'no_llm_conservative.jsonl'),
      out_dir: outDir,
    })
    assert.equal(code, EXIT_OK)
    const jobs = list_jobs()
    assert.equal(jobs.length, 1)
    assert.equal(get_cut_progress(jobs[0]!.job_id).holes, 'skipped')
  })

  it('without --no-llm and injected FakeSessionBackend runs with_llm', async () => {
    setSessionBackend(
      new FakeSessionBackend((input, opts) => {
        if (opts.role === 'hole_a_skeleton') {
          const json = {
            kind: SKELETON_PASS_JSON_KIND,
            intent: { text: 'Fix add' },
            scenario: 'implement',
            skeleton: { nodes: [] },
          }
          return {
            text: JSON.stringify(json),
            json,
            tool_calls: [],
            usage: { role: opts.role, input_tokens: 2, output_tokens: 2 },
          }
        }
        const match = input.text.match(/window_segment_ids:\s*(\[[^\]]*\])/)
        const ids = match?.[1] !== undefined ? (JSON.parse(match[1]) as string[]) : []
        return {
          text: '',
          json: null,
          tool_calls: ids.map((segment_id) => ({
            name: 'label_segment',
            arguments: { segment_id, label: 'key_decision', confidence: 0.8 },
          })),
          usage: { role: opts.role, input_tokens: 2, output_tokens: 2 },
        }
      }),
    )
    const outDir = tmp()
    const code = await runCli({
      command: 'distill',
      input_path: join(fixtures, 'no_llm_conservative.jsonl'),
      out_dir: outDir,
    })
    assert.equal(code, EXIT_OK)
    const jobs = list_jobs()
    assert.equal(jobs.length, 1)
    assert.equal(get_cut_progress(jobs[0]!.job_id).holes, 'done')
  })
})
