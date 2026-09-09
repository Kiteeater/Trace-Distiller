import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  LIVE_TOOL_NAMES,
  UnknownJobError,
  attach_job,
  detach_job,
  get_cut_progress,
  get_partial_result,
  get_warrant_tail,
  list_jobs,
  type LiveToolName,
} from './live.ts'

/**
 * 可选 Unix domain socket 传输。默认关闭。
 * 进程内 `registerJobFromResult` 仍是源；本文件只把 live 六工具挂到 sock 文件上。
 * 禁止 HTTP / TCP listen。
 */

export interface StartLiveSocketOpts {
  path: string
}

export interface LiveSocketRequest {
  op: LiveToolName
  job_id?: string
  limit?: number
}

export interface LiveSocketOk {
  ok: true
  op: LiveToolName
  result: unknown
}

export interface LiveSocketErr {
  ok: false
  op: string
  error: { name: string; message: string; job_id?: string }
}

export type LiveSocketResponse = LiveSocketOk | LiveSocketErr

const TOOL_SET = new Set<string>(LIVE_TOOL_NAMES)

let server: Server | undefined
let socketPath: string | undefined
const clients = new Set<Socket>()

export function liveSocketPath(): string | undefined {
  return socketPath
}

export async function startLiveSocket(opts: StartLiveSocketOpts): Promise<void> {
  if (server !== undefined) {
    throw new Error('live unix socket already listening')
  }
  const path = opts.path
  if (path.length === 0 || /^\d+$/.test(path)) {
    throw new Error('live socket path must be a filesystem path, not a TCP port')
  }
  if (existsSync(path)) unlinkSync(path)

  const next = createServer((sock) => {
    clients.add(sock)
    sock.on('close', () => {
      clients.delete(sock)
    })
    serveConnection(sock)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      next.off('listening', onListening)
      next.close()
      reject(err)
    }
    const onListening = (): void => {
      next.off('error', onError)
      resolve()
    }
    next.once('error', onError)
    next.once('listening', onListening)
    next.listen(path)
  })

  server = next
  socketPath = path
}

export async function stopLiveSocket(): Promise<void> {
  const running = server
  const path = socketPath
  server = undefined
  socketPath = undefined
  if (running === undefined) return

  for (const sock of clients) {
    sock.destroy()
  }
  clients.clear()

  await new Promise<void>((resolve, reject) => {
    running.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })

  if (path !== undefined && existsSync(path)) unlinkSync(path)
}

function serveConnection(sock: Socket): void {
  sock.setEncoding('utf8')
  let buf = ''
  sock.on('data', (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.length > 0) writeLine(sock, handleLine(line))
      nl = buf.indexOf('\n')
    }
  })
}

function handleLine(line: string): LiveSocketResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return fail('invalid_json', 'malformed JSON line')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('invalid_json', 'request must be a JSON object')
  }
  const row = parsed as Record<string, unknown>
  const op = row.op
  if (typeof op !== 'string' || !TOOL_SET.has(op)) {
    return fail(typeof op === 'string' ? op : 'unknown', `unknown op: ${String(op)}`)
  }
  try {
    return { ok: true, op: op as LiveToolName, result: dispatch(op as LiveToolName, row) }
  } catch (err) {
    if (err instanceof UnknownJobError) {
      return {
        ok: false,
        op,
        error: { name: err.name, message: err.message, job_id: err.job_id },
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return fail(op, message)
  }
}

function dispatch(op: LiveToolName, row: Record<string, unknown>): unknown {
  switch (op) {
    case 'list_jobs':
      return list_jobs()
    case 'attach_job':
      return attach_job(requireJobId(row))
    case 'detach_job':
      return detach_job(requireJobId(row))
    case 'get_cut_progress':
      return get_cut_progress(requireJobId(row))
    case 'get_partial_result':
      return get_partial_result(requireJobId(row))
    case 'get_warrant_tail': {
      const job_id = requireJobId(row)
      const limit = row.limit
      if (limit === undefined) return get_warrant_tail(job_id)
      if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        throw new Error('limit must be a number')
      }
      return get_warrant_tail(job_id, limit)
    }
  }
}

function requireJobId(row: Record<string, unknown>): string {
  const job_id = row.job_id
  if (typeof job_id !== 'string' || job_id.length === 0) {
    throw new Error('job_id required')
  }
  return job_id
}

function fail(op: string, message: string): LiveSocketErr {
  return { ok: false, op, error: { name: 'LiveSocketError', message } }
}

function writeLine(sock: Socket, body: LiveSocketResponse): void {
  sock.write(`${JSON.stringify(body)}\n`)
}
