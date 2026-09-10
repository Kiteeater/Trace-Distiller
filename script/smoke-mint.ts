import { openSession } from '../src/agent/sessions/open_session.ts'
import { loadLocalEnvFile } from '../src/utils/env.ts'

loadLocalEnvFile()

const base = process.env.TRACE_DISTILLER_API_BASE
const key = process.env.TRACE_DISTILLER_API_KEY
if (typeof base !== 'string' || base.length === 0 || typeof key !== 'string' || key.length === 0) {
  process.stderr.write('skip: TRACE_DISTILLER_API_BASE / TRACE_DISTILLER_API_KEY not set\n')
  process.exit(0)
}

function redact(text: string): string {
  const secret = process.env.TRACE_DISTILLER_API_KEY
  if (typeof secret !== 'string' || secret.length === 0) return text
  return text.split(secret).join('[redacted]')
}

const handle = openSession({ role: 'hole_a_skeleton' })
try {
  const out = await handle.prompt({ text: 'Reply with the single word pong.' })
  process.stdout.write(`${out.text.trim()}\n`)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`${redact(msg)}\n`)
  process.exit(1)
} finally {
  handle.dispose()
}
