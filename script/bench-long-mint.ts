/**
 * Long-only mint bench path.
 *
 * Runs `bench --with-l4 --bin long` with a raised session timeout so slow
 * hole A/B + L4 calls can finish. Prefer a single MIMO sample when
 * TRACE_DISTILLER_BENCH_LONG_SAMPLE is set (filename under datasets/long/).
 *
 * Usage:
 *   bun run bench:long:mint
 *   TRACE_DISTILLER_SESSION_TIMEOUT_MS=300000 bun run bench:long:mint
 *   TRACE_DISTILLER_BENCH_LONG_SAMPLE=mimo-debug-parse.jsonl bun run bench:long:mint
 *
 * Requires .env mint credentials. Never logs API keys.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgv, runCli } from '../src/service/cli.ts'
import { loadLocalEnvFile } from '../src/utils/env.ts'

// Same as run-distill.ts: load cwd .env so --with-l4 sees MODEL_* / API_*.
// Never log values.
loadLocalEnvFile()

const ROOT = process.cwd()
const TIMEOUT_ENV = 'TRACE_DISTILLER_SESSION_TIMEOUT_MS'
const SAMPLE_ENV = 'TRACE_DISTILLER_BENCH_LONG_SAMPLE'

async function main(): Promise<number> {
  if (process.env[TIMEOUT_ENV] === undefined || process.env[TIMEOUT_ENV] === '') {
    process.env[TIMEOUT_ENV] = '300000'
  }
  const timeoutMs = Number(process.env[TIMEOUT_ENV])
  if (!Number.isFinite(timeoutMs) || timeoutMs < 300_000) {
    process.stderr.write(
      `${TIMEOUT_ENV} should be >= 300000 for long mint (got ${String(process.env[TIMEOUT_ENV])})\n`,
    )
  }

  const outDir = join(ROOT, 'benchmark', 'out-long-mint')
  mkdirSync(outDir, { recursive: true })

  const sampleName = process.env[SAMPLE_ENV]?.trim()
  let datasetsDir = join(ROOT, 'benchmark', 'datasets')
  let scratch: string | undefined

  if (sampleName !== undefined && sampleName.length > 0) {
    const srcJsonl = join(ROOT, 'benchmark', 'datasets', 'long', sampleName)
    if (!existsSync(srcJsonl)) {
      process.stderr.write(`sample not found: ${srcJsonl}\n`)
      return 1
    }
    scratch = mkdtempSync(join(tmpdir(), 'td-long-mint-'))
    const longDir = join(scratch, 'long')
    mkdirSync(longDir, { recursive: true })
    mkdirSync(join(scratch, 'short'), { recursive: true })
    mkdirSync(join(scratch, 'multi_dead_end'), { recursive: true })
    copyFileSync(srcJsonl, join(longDir, sampleName))
    const kdName = sampleName.replace(/\.jsonl$/u, '.key-decisions.json')
    const kd = join(ROOT, 'benchmark', 'datasets', 'long', kdName)
    if (existsSync(kd)) {
      copyFileSync(kd, join(longDir, kdName))
    }
    datasetsDir = scratch
    process.stderr.write(`long mint single sample: ${sampleName}\n`)
  } else {
    process.stderr.write(
      `long mint all long/*.jsonl (set ${SAMPLE_ENV}=mimo-debug-parse.jsonl for one sample)\n`,
    )
  }

  try {
    const args = parseArgv([
      'bench',
      '--dir',
      datasetsDir,
      '--out-dir',
      outDir,
      '--with-l4',
      '--bin',
      'long',
    ])
    return await runCli(args)
  } finally {
    if (scratch !== undefined) {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

const code = await main()
process.exit(code)
