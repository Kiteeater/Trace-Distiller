import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDb, getTraceMeta, listSegments } from '../../src/data/data_segment.ts'
import { ruleCoverage } from '../../src/data/data_label.ts'
import { EXIT_ADMISSION, EXIT_OK, parseArgv, runCli } from '../../src/service/cli.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const fixtures = join(here, '../fixtures/claude_code')
const cliSrc = join(here, '../../src/service/cli.ts')
const scriptSrc = join(here, '../../script/run-distill.ts')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'distiller-cli-'))
}

describe('cli', () => {
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
})
