import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDb, getTraceMeta, listSegments } from '../../src/data/data_segment.ts'
import { getMetrics } from '../../src/data/data_metric.ts'
import { ruleCoverage } from '../../src/data/data_label.ts'
import { FakeSessionBackend, setSessionBackend } from '../../src/agent/sessions/open_session.ts'
import { SKELETON_PASS_JSON_KIND } from '../../src/agent/sessions/skeleton_pass.ts'
import { EXIT_ADMISSION, EXIT_OK, parseArgv, runCli } from '../../src/service/cli.ts'
import { LIVE_TOOL_NAMES, get_cut_progress, list_jobs, resetLiveState } from '../../src/service/live.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const fixtures = join(here, '../fixtures/claude_code')
const cliSrc = join(here, '../../src/service/cli.ts')
const liveSrc = join(here, '../../src/service/live.ts')
const livePageSrc = join(here, '../../src/report/live_page.ts')
const scriptSrc = join(here, '../../script/run-distill.ts')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'distiller-cli-'))
}

describe('cli', { concurrency: 1 }, () => {
  afterEach(() => {
    setSessionBackend(undefined)
    resetLiveState()
  })

  it('--help says live is Distiller cut, not the other agent', async () => {
    const chunks: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write
    try {
      const code = await runCli({ command: 'distill', input_path: '', help: true })
      assert.equal(code, EXIT_OK)
    } finally {
      process.stderr.write = origWrite
    }
    const help = chunks.join('')
    assert.match(help, /live-dump/)
    assert.match(help, /Distiller/)
    assert.match(help, /not the other agent/)
    assert.match(help, /No HTTP listen/)
    assert.match(help, /live-socket/)
    assert.match(help, /Unix domain socket/)
    assert.match(help, /CutProfile/)
    assert.match(help, /--qa/)
    assert.match(help, /--replay/)
    assert.match(help, /TRACE_DISTILLER_MODEL_L4/)
    assert.match(help, /TRACE_DISTILLER_API_BASE/)
    assert.match(help, /Keys are never logged/)
    assert.match(help, /bench/)
    assert.match(help, /never averaged/)
    assert.match(help, /--fake-l4/)
    assert.match(help, /--with-l4/)
    assert.match(help, /Default is --no-llm/)
  })

  it('does not import pi, createAgentSession, or listen', () => {
    const src = readFileSync(cliSrc, 'utf8')
    const script = readFileSync(scriptSrc, 'utf8')
    const live = readFileSync(liveSrc, 'utf8')
    const page = readFileSync(livePageSrc, 'utf8')
    for (const text of [src, script, live, page]) {
      assert.doesNotMatch(text, /@mariozechner\/pi/)
      assert.doesNotMatch(text, /createAgentSession/)
      assert.doesNotMatch(text, /from ['"]pi['"]/)
      assert.doesNotMatch(text, /\.listen\s*\(/)
      assert.doesNotMatch(text, /createServer/)
    }
    assert.match(script, /loadLocalEnvFile/)
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
      '--live-dump',
      'live-out',
      '--live-socket',
      '/tmp/distiller.live.sock',
      '--no-llm',
    ])
    assert.equal(args.command, 'distill')
    assert.equal(args.input_path, 'a.jsonl')
    assert.equal(args.profile_path, 'p.json')
    assert.equal(args.sqlite_path, 'db.sqlite')
    assert.equal(args.out_dir, 'out')
    assert.equal(args.report_path, 'r.html')
    assert.equal(args.live_dump_dir, 'live-out')
    assert.equal(args.live_socket_path, '/tmp/distiller.live.sock')
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
      const stored = getMetrics(db, trainingJson.trace_id)
      assert.ok(stored)
      assert.ok(stored.compression_ratio > 0)
      assert.ok(stored.rule_coverage > 0)
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

  it('script --help does not print API keys after loading .env', () => {
    const result = spawnSync(process.execPath, [scriptSrc, '--help'], {
      encoding: 'utf8',
      cwd: repoRoot,
    })
    assert.equal(result.status, 0, result.stderr)
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.doesNotMatch(combined, /sk-[0-9a-f]{16,}/i)
    assert.match(combined, /TRACE_DISTILLER_API_BASE/)
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
    const prevL4 = process.env.TRACE_DISTILLER_MODEL_L4
    const prevHoleA = process.env.TRACE_DISTILLER_MODEL_HOLE_A
    const prevHoleB = process.env.TRACE_DISTILLER_MODEL_HOLE_B
    delete process.env.TRACE_DISTILLER_MODEL_L4
    delete process.env.TRACE_DISTILLER_MODEL_HOLE_A
    delete process.env.TRACE_DISTILLER_MODEL_HOLE_B
    setSessionBackend(undefined)
    try {
      const code = await runCli({
        command: 'distill',
        input_path: join(fixtures, 'no_llm_conservative.jsonl'),
        out_dir: outDir,
      })
      assert.equal(code, EXIT_OK)
      const jobs = list_jobs()
      assert.equal(jobs.length, 1)
      assert.equal(get_cut_progress(jobs[0]!.job_id).holes, 'skipped')
    } finally {
      if (prevL4 === undefined) delete process.env.TRACE_DISTILLER_MODEL_L4
      else process.env.TRACE_DISTILLER_MODEL_L4 = prevL4
      if (prevHoleA === undefined) delete process.env.TRACE_DISTILLER_MODEL_HOLE_A
      else process.env.TRACE_DISTILLER_MODEL_HOLE_A = prevHoleA
      if (prevHoleB === undefined) delete process.env.TRACE_DISTILLER_MODEL_HOLE_B
      else process.env.TRACE_DISTILLER_MODEL_HOLE_B = prevHoleB
    }
  })

  it('eval and report reconstruct metrics and html from sqlite after no_llm distill', async () => {
    const outDir = tmp()
    const sqlite = join(outDir, 'distiller.sqlite')
    const distillCode = await runCli({
      command: 'distill',
      input_path: join(fixtures, 'no_llm_conservative.jsonl'),
      out_dir: outDir,
      sqlite_path: sqlite,
      no_llm: true,
    })
    assert.equal(distillCode, EXIT_OK)

    const db = openDb(sqlite)
    let traceId = ''
    try {
      const names = readdirSync(outDir)
      const training = names.find((n) => n.endsWith('-training.json'))
      assert.ok(training)
      traceId = (JSON.parse(readFileSync(join(outDir, training), 'utf8')) as { trace_id: string })
        .trace_id
      const stored = getMetrics(db, traceId)
      assert.ok(stored)
      assert.ok(stored.compression_ratio > 0)
    } finally {
      db.close()
    }

    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      const evalCode = await runCli({
        command: 'eval',
        input_path: traceId,
        sqlite_path: sqlite,
      })
      assert.equal(evalCode, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
    }
    const evalLine = chunks
      .join('')
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row.startsWith('{'))
      .at(-1)
    assert.ok(evalLine, `expected eval JSON, got ${JSON.stringify(chunks)}`)
    const evalJson = JSON.parse(evalLine) as {
      compression_ratio: number
      rule_coverage: number
      fail_closed_count: number
      replay: null
      qa: null
      note: string
    }
    assert.ok(evalJson.compression_ratio > 0)
    assert.ok(evalJson.rule_coverage > 0)
    assert.equal(evalJson.replay, null)
    assert.equal(evalJson.qa, null)
    assert.match(evalJson.note, /L4/)

    const skipChunks: string[] = []
    const prevL4 = process.env.TRACE_DISTILLER_MODEL_L4
    const prevHoleA = process.env.TRACE_DISTILLER_MODEL_HOLE_A
    const prevHoleB = process.env.TRACE_DISTILLER_MODEL_HOLE_B
    delete process.env.TRACE_DISTILLER_MODEL_L4
    delete process.env.TRACE_DISTILLER_MODEL_HOLE_A
    delete process.env.TRACE_DISTILLER_MODEL_HOLE_B
    setSessionBackend(undefined)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      skipChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      const skipCode = await runCli({
        command: 'eval',
        input_path: traceId,
        sqlite_path: sqlite,
        qa: true,
        replay: true,
      })
      assert.equal(skipCode, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
      if (prevL4 === undefined) delete process.env.TRACE_DISTILLER_MODEL_L4
      else process.env.TRACE_DISTILLER_MODEL_L4 = prevL4
      if (prevHoleA === undefined) delete process.env.TRACE_DISTILLER_MODEL_HOLE_A
      else process.env.TRACE_DISTILLER_MODEL_HOLE_A = prevHoleA
      if (prevHoleB === undefined) delete process.env.TRACE_DISTILLER_MODEL_HOLE_B
      else process.env.TRACE_DISTILLER_MODEL_HOLE_B = prevHoleB
    }
    const skipLine = skipChunks
      .join('')
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row.startsWith('{'))
      .at(-1)
    assert.ok(skipLine, `expected eval skip JSON, got ${JSON.stringify(skipChunks)}`)
    const skipJson = JSON.parse(skipLine) as { qa: number | null; replay: number | null; note: string }
    assert.equal(skipJson.qa, null)
    assert.equal(skipJson.replay, null)
    assert.match(skipJson.note, /skipped/)
    assert.match(skipJson.note, /TRACE_DISTILLER_MODEL_L4/)

    setSessionBackend(new FakeSessionBackend())
    const runChunks: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      runChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      const runCode = await runCli({
        command: 'eval',
        input_path: traceId,
        sqlite_path: sqlite,
        qa: true,
        replay: true,
      })
      assert.equal(runCode, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
      setSessionBackend(undefined)
    }
    const runJson = JSON.parse(runChunks.join('')) as { qa: number | null; replay: number | null }
    assert.equal(runJson.qa, 1)
    assert.equal(runJson.replay, 1)

    const reportPath = join(outDir, 'from-sqlite.html')
    const reportCode = await runCli({
      command: 'report',
      input_path: traceId,
      sqlite_path: sqlite,
      out_path: reportPath,
    })
    assert.equal(reportCode, EXIT_OK)
    const html = readFileSync(reportPath, 'utf8')
    assert.match(html, /data-compression-ratio=/)
    assert.match(html, new RegExp(String(evalJson.compression_ratio)))
  })

  it('parseArgv reads eval/report flags', () => {
    const evalArgs = parseArgv(['eval', 'trace-1', '--sqlite', 'db.sqlite'])
    assert.equal(evalArgs.command, 'eval')
    assert.equal(evalArgs.input_path, 'trace-1')
    assert.equal(evalArgs.sqlite_path, 'db.sqlite')
    const evalL4 = parseArgv(['eval', 'trace-1', '--sqlite', 'db.sqlite', '--qa', '--replay'])
    assert.equal(evalL4.qa, true)
    assert.equal(evalL4.replay, true)
    const reportArgs = parseArgv([
      'report',
      'trace-1',
      '--sqlite',
      'db.sqlite',
      '--out',
      'out.html',
    ])
    assert.equal(reportArgs.command, 'report')
    assert.equal(reportArgs.out_path, 'out.html')
    const liveArgs = parseArgv(['live-dump', '--sqlite', 'db.sqlite', '--out-dir', 'live'])
    assert.equal(liveArgs.command, 'live-dump')
    assert.equal(liveArgs.sqlite_path, 'db.sqlite')
    assert.equal(liveArgs.out_dir, 'live')
    const benchArgs = parseArgv(['bench', '--dir', 'benchmark/datasets', '--fake-l4', '--no-llm'])
    assert.equal(benchArgs.command, 'bench')
    assert.equal(benchArgs.datasets_dir, 'benchmark/datasets')
    assert.equal(benchArgs.fake_l4, true)
    assert.equal(benchArgs.no_llm, true)
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

  it('--live-dump writes job json and self-contained live.html', async () => {
    resetLiveState()
    const outDir = tmp()
    const liveDir = join(outDir, 'live')
    const code = await runCli({
      command: 'distill',
      input_path: join(fixtures, 'no_llm_conservative.jsonl'),
      out_dir: outDir,
      live_dump_dir: liveDir,
      no_llm: true,
    })
    assert.equal(code, EXIT_OK)
    const jobs = list_jobs()
    assert.equal(jobs.length, 1)
    const jobId = jobs[0]!.job_id
    const dumpPath = join(liveDir, `${jobId}.live.json`)
    assert.equal(existsSync(dumpPath), true)
    const snap = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, unknown>
    for (const name of LIVE_TOOL_NAMES) {
      assert.ok(Object.hasOwn(snap, name), `dump missing ${name}`)
    }
    const html = readFileSync(join(liveDir, 'live.html'), 'utf8')
    assert.match(html, /不是对方 agent/)
    assert.match(html, /data-stage="segment"/)
    assert.doesNotMatch(html, /send_message/)
  })

  it('--live-socket unlinks the sock file when distill ends', async () => {
    resetLiveState()
    const outDir = tmp()
    const sock = join(outDir, 'live.sock')
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      const code = await runCli({
        command: 'distill',
        input_path: join(fixtures, 'no_llm_conservative.jsonl'),
        out_dir: outDir,
        live_socket_path: sock,
        no_llm: true,
      })
      assert.equal(code, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
    }
    assert.equal(existsSync(sock), false)
    const line = chunks
      .join('')
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row.startsWith('{'))
      .at(-1)
    assert.ok(line, `expected distill summary JSON, got ${JSON.stringify(chunks)}`)
    const summary = JSON.parse(line) as { live_socket?: string; job_id?: string }
    assert.equal(summary.live_socket, sock)
    assert.ok(summary.job_id)
  })

  it('live-dump --sqlite exports the latest stored result', async () => {
    resetLiveState()
    const outDir = tmp()
    const sqlite = join(outDir, 'distiller.sqlite')
    const distillCode = await runCli({
      command: 'distill',
      input_path: join(fixtures, 'no_llm_conservative.jsonl'),
      out_dir: outDir,
      sqlite_path: sqlite,
      no_llm: true,
    })
    assert.equal(distillCode, EXIT_OK)
    resetLiveState()
    const liveDir = join(outDir, 'from-sqlite-live')
    const dumpCode = await runCli({
      command: 'live-dump',
      input_path: '',
      sqlite_path: sqlite,
      out_dir: liveDir,
    })
    assert.equal(dumpCode, EXIT_OK)
    assert.equal(existsSync(join(liveDir, 'live.html')), true)
    const html = readFileSync(join(liveDir, 'live.html'), 'utf8')
    assert.match(html, /不是对方 agent/)
    const names = readdirSync(liveDir)
    assert.ok(names.some((n) => n.endsWith('.live.json')), names.join(','))
  })

  it('bench prints per-track JSON and does not average bins', async () => {
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      const code = await runCli({
        command: 'bench',
        input_path: '',
        datasets_dir: join(repoRoot, 'benchmark/datasets'),
        no_llm: true,
      })
      assert.equal(code, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
    }
    const line = chunks
      .join('')
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row.startsWith('{'))
      .at(-1)
    assert.ok(line, `expected bench JSON, got ${JSON.stringify(chunks)}`)
    const report = JSON.parse(line) as {
      bins: {
        short: { n: number; samples: Array<{ gold: string; composite: number | null }> }
        long: { n: number }
        multi_dead_end: { n: number }
      }
      overall?: unknown
    }
    assert.ok(report.bins.short.n >= 1)
    assert.ok(report.bins.long.n >= 1)
    assert.ok(report.bins.multi_dead_end.n >= 1)
    assert.equal(report.bins.short.samples[0]?.gold, 'independent')
    assert.equal(report.overall, undefined)
    assert.doesNotMatch(line, /"overall"/)
  })

  it('bench --no-llm --fake-l4 yields fluff composite > 0 without mint', async () => {
    const outDir = tmp()
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      const code = await runCli({
        command: 'bench',
        input_path: '',
        datasets_dir: join(repoRoot, 'benchmark/datasets'),
        out_dir: outDir,
        no_llm: true,
        fake_l4: true,
      })
      assert.equal(code, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
    }
    const line = chunks
      .join('')
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row.startsWith('{'))
      .at(-1)
    assert.ok(line, `expected bench JSON, got ${JSON.stringify(chunks)}`)
    const report = JSON.parse(line) as {
      fake_l4?: boolean
      l4?: boolean
      bins: {
        short: {
          samples: Array<{
            trace_id: string
            composite: number | null
            metrics: { replay: { value: number | null; status: string } }
            notes?: string[]
          }>
        }
      }
    }
    assert.equal(report.fake_l4, true)
    assert.equal(report.l4, true)
    const fluff = report.bins.short.samples.find((s) => s.trace_id.includes('short-fluff'))
    assert.ok(fluff, 'missing fluff sample')
    assert.equal(fluff!.metrics.replay.status, 'pass')
    assert.equal(fluff!.metrics.replay.value, 1)
    assert.ok(fluff!.composite !== null && fluff!.composite > 0, `composite=${String(fluff!.composite)}`)
    assert.ok((fluff!.notes ?? []).some((n) => /verify ok|heal/.test(n)))
    const md = readFileSync(join(outDir, 'scoreboard.md'), 'utf8')
    assert.match(md, /short-fluff/)
    assert.match(md, /### notes/)
  })

  it('parseArgv reads --with-l4', () => {
    const args = parseArgv(['bench', '--with-l4', '--dir', 'benchmark/datasets'])
    assert.equal(args.command, 'bench')
    assert.equal(args.with_l4, true)
  })

  it('bench defaults to no_llm even when mint env is set (no hang)', async () => {
    const prevA = process.env.TRACE_DISTILLER_MODEL_HOLE_A
    const prevL4 = process.env.TRACE_DISTILLER_MODEL_L4
    process.env.TRACE_DISTILLER_MODEL_HOLE_A = 'macaron/macaron-v1-coding-venti'
    process.env.TRACE_DISTILLER_MODEL_L4 = 'macaron/macaron-v1-coding-venti'
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    const started = Date.now()
    try {
      const code = await runCli({
        command: 'bench',
        input_path: '',
        datasets_dir: join(repoRoot, 'benchmark/datasets'),
        // deliberately omit no_llm / with_l4 / fake_l4
      })
      assert.equal(code, EXIT_OK)
    } finally {
      process.stdout.write = origWrite
      if (prevA === undefined) delete process.env.TRACE_DISTILLER_MODEL_HOLE_A
      else process.env.TRACE_DISTILLER_MODEL_HOLE_A = prevA
      if (prevL4 === undefined) delete process.env.TRACE_DISTILLER_MODEL_L4
      else process.env.TRACE_DISTILLER_MODEL_L4 = prevL4
    }
    const elapsed = Date.now() - started
    assert.ok(elapsed < 60_000, `bench must not hang on mint env; took ${elapsed}ms`)
    const line = chunks
      .join('')
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row.startsWith('{'))
      .at(-1)
    assert.ok(line, `expected bench JSON, got ${JSON.stringify(chunks)}`)
    const report = JSON.parse(line) as {
      mode: string
      l4: boolean
      with_l4?: boolean
      bins: { short: { samples: Array<{ notes?: string[] }> } }
    }
    assert.equal(report.mode, 'no_llm')
    assert.equal(report.l4, false)
    assert.equal(report.with_l4, false)
    const noteBlob = (report.bins.short.samples[0]?.notes ?? []).join(' ')
    assert.match(noteBlob, /l4 skipped: pass --with-l4/)
  })
})
