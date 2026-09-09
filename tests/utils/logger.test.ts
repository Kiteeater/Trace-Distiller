import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { error, info, log, warn } from '../../src/utils/logger.ts'

const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/utils/logger.ts')

function captureStderr(fn: () => void): string {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = orig
  }
  return chunks.join('')
}

describe('logger', () => {
  it('is a thin stderr writer with no framework or state', () => {
    const src = readFileSync(srcPath, 'utf8')
    assert.doesNotMatch(src, /winston|pino|bunyan|debug\(|createLogger/)
    assert.doesNotMatch(src, /writeFile|appendFile|createWriteStream/)
    assert.doesNotMatch(src, /sqlite|createAgentSession/)
    assert.match(src, /process\.stderr\.write/)
  })

  it('writes info/warn/error to stderr', () => {
    const out = captureStderr(() => {
      log('info', 'hello')
      info('ok', { n: 1 })
      warn('careful')
      error('boom', { code: 'x' })
    })
    assert.match(out, /\[info\] hello\n/)
    assert.match(out, /\[info\] ok \{"n":1\}\n/)
    assert.match(out, /\[warn\] careful\n/)
    assert.match(out, /\[error\] boom \{"code":"x"\}\n/)
  })
})
