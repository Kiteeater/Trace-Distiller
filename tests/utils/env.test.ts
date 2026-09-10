import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadEnvFile, loadLocalEnvFile, parseEnvFile } from '../../src/utils/env.ts'

describe('env file loader', () => {
  it('parses KEY=value, export, quotes, and comments', () => {
    const parsed = parseEnvFile(
      [
        '# comment',
        '',
        'FOO=bar',
        'export BAZ=qux',
        'QUOTED="https://example.invalid/v1"',
        "SINGLE='abc'",
        'BAD LINE',
        '1NOT=ok',
        'EMPTY=',
      ].join('\n'),
    )
    assert.deepEqual(parsed, {
      FOO: 'bar',
      BAZ: 'qux',
      QUOTED: 'https://example.invalid/v1',
      SINGLE: 'abc',
      EMPTY: '',
    })
  })

  it('loads missing keys only and does not log values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distiller-env-'))
    writeFileSync(
      join(dir, '.env'),
      ['TRACE_DISTILLER_API_KEY=sk-test-not-a-real-key', 'KEEP_ME=from-file', 'ALREADY=from-file'].join('\n'),
      'utf8',
    )
    const env: NodeJS.Dict<string> = { ALREADY: 'from-process' }
    const chunks: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write
    try {
      assert.equal(loadLocalEnvFile(dir, env), true)
      assert.equal(loadEnvFile(join(dir, 'missing.env'), env), false)
    } finally {
      process.stderr.write = orig
    }
    assert.equal(env.TRACE_DISTILLER_API_KEY, 'sk-test-not-a-real-key')
    assert.equal(env.KEEP_ME, 'from-file')
    assert.equal(env.ALREADY, 'from-process')
    assert.equal(chunks.join(''), '')
  })
})
