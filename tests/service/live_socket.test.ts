import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { distill } from '../../src/pipeline/orchestrator.ts'
import { list_jobs, registerJobFromResult, resetLiveState } from '../../src/service/live.ts'
import {
  liveSocketPath,
  startLiveSocket,
  stopLiveSocket,
  type LiveSocketResponse,
} from '../../src/service/live_socket.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')
const socketSrc = join(here, '../../src/service/live_socket.ts')
const liveSrc = join(here, '../../src/service/live.ts')
const cliSrc = join(here, '../../src/service/cli.ts')

function tmpSock(): string {
  return join(mkdtempSync(join(tmpdir(), 'distiller-sock-')), 'live.sock')
}

function rpc(path: string, payload: Record<string, unknown>): Promise<LiveSocketResponse> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('error', reject)
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      sock.end()
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as LiveSocketResponse)
      } catch (err) {
        reject(err)
      }
    })
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(payload)}\n`)
    })
  })
}

describe('live unix socket', () => {
  afterEach(async () => {
    await stopLiveSocket()
    resetLiveState()
  })

  it('does not createServer({port}), listen a numeric port, or import http', () => {
    const src = readFileSync(socketSrc, 'utf8')
    const live = readFileSync(liveSrc, 'utf8')
    const cli = readFileSync(cliSrc, 'utf8')
    for (const text of [src, live, cli]) {
      assert.doesNotMatch(text, /node:http/)
      assert.doesNotMatch(text, /from ['"]http['"]/)
      assert.doesNotMatch(text, /createServer\s*\(\s*\{[^}]*\bport\b/)
      assert.doesNotMatch(text, /\.listen\s*\(\s*\d+/)
      assert.doesNotMatch(text, /\.listen\s*\(\s*\{[^}]*\bport\b/)
      assert.doesNotMatch(text, /@mariozechner\/pi/)
      assert.doesNotMatch(text, /createAgentSession/)
    }
    assert.match(src, /createServer/)
    assert.match(src, /\.listen\(\s*path\s*\)/)
    assert.doesNotMatch(live, /createServer/)
    assert.doesNotMatch(cli, /createServer/)
  })

  it('rejects a numeric path so TCP ports cannot sneak in', async () => {
    await assert.rejects(
      () => startLiveSocket({ path: '8080' }),
      /filesystem path, not a TCP port/,
    )
    assert.equal(liveSocketPath(), undefined)
  })

  it('serves list_jobs and get_cut_progress over a sock file', async () => {
    resetLiveState()
    const path = tmpSock()
    await startLiveSocket({ path })
    assert.equal(liveSocketPath(), path)
    assert.equal(existsSync(path), true)

    const empty = await rpc(path, { op: 'list_jobs' })
    assert.equal(empty.ok, true)
    assert.equal(empty.op, 'list_jobs')
    if (empty.ok) assert.deepEqual(empty.result, [])

    const raw = parse(readFileSync(join(fixtures, 'no_llm_conservative.jsonl'), 'utf8'))
    const result = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })
    const job_id = registerJobFromResult(result)
    assert.equal(list_jobs().length, 1)

    const listed = await rpc(path, { op: 'list_jobs' })
    assert.equal(listed.ok, true)
    if (listed.ok) {
      const jobs = listed.result as Array<{ job_id: string; trace_id: string }>
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0]?.job_id, job_id)
      assert.equal(jobs[0]?.trace_id, raw.meta.trace_id)
    }

    const progress = await rpc(path, { op: 'get_cut_progress', job_id })
    assert.equal(progress.ok, true)
    if (progress.ok) {
      const row = progress.result as { job_id: string; segment: string; holes: string }
      assert.equal(row.job_id, job_id)
      assert.equal(row.segment, 'done')
      assert.equal(row.holes, 'skipped')
    }

    const missing = await rpc(path, { op: 'get_cut_progress', job_id: 'nope' })
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.equal(missing.error.name, 'UnknownJobError')
      assert.equal(missing.error.job_id, 'nope')
    }

    await stopLiveSocket()
    assert.equal(existsSync(path), false)
    assert.equal(liveSocketPath(), undefined)
  })
})
