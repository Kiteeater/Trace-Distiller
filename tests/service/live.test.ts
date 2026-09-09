import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { compressionRatio } from '../../src/eval/metrics.ts'
import { distill } from '../../src/pipeline/orchestrator.ts'
import {
  LIVE_TOOL_NAMES,
  UnknownJobError,
  attach_job,
  detach_job,
  get_cut_progress,
  get_partial_result,
  get_warrant_tail,
  list_jobs,
  registerJobFromResult,
  resetLiveState,
} from '../../src/service/live.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')
const liveSrc = join(here, '../../src/service/live.ts')

describe('live in-memory jobs', () => {
  it('does not import pi or listen', () => {
    const src = readFileSync(liveSrc, 'utf8')
    assert.doesNotMatch(src, /@mariozechner\/pi/)
    assert.doesNotMatch(src, /createAgentSession/)
    assert.doesNotMatch(src, /\.listen\s*\(/)
    assert.doesNotMatch(src, /createServer/)
    assert.doesNotMatch(src, /export function (send_message|interrupt|inject_prompt|list_sessions)/)
    assert.deepEqual([...LIVE_TOOL_NAMES], [
      'list_jobs',
      'attach_job',
      'detach_job',
      'get_cut_progress',
      'get_partial_result',
      'get_warrant_tail',
    ])
  })

  it('registers DistillResult and serves the six subscribe tools', async () => {
    resetLiveState()
    const raw = parse(readFileSync(join(fixtures, 'no_llm_conservative.jsonl'), 'utf8'))
    const result = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })
    const job_id = registerJobFromResult(result)

    const listed = list_jobs()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.job_id, job_id)
    assert.equal(listed[0]?.trace_id, raw.meta.trace_id)
    assert.equal(listed[0]?.attached, false)
    assert.equal(listed[0]?.status, 'done')

    const attached = attach_job(job_id)
    assert.equal(attached.attached, true)
    assert.equal(list_jobs()[0]?.attached, true)

    const progress = get_cut_progress(job_id)
    const cut = result.training.turns.reduce((sum, t) => sum + t.tokens, 0)
    assert.equal(progress.segment, 'done')
    assert.equal(progress.rules, 'done')
    assert.equal(progress.holes, 'skipped')
    assert.equal(progress.assemble, 'done')
    assert.equal(
      progress.compression_ratio,
      compressionRatio({ original_tokens: raw.meta.total_tokens, cut_tokens: cut }),
    )

    const partial = get_partial_result(job_id)
    assert.equal(partial.playback.trace_id, result.playback.trace_id)
    assert.deepEqual(partial.cards, result.playback.cards)

    const tail = get_warrant_tail(job_id, 2)
    assert.equal(tail.length, Math.min(2, result.warrant.entries.length))
    assert.deepEqual(tail, result.warrant.entries.slice(-tail.length))
    assert.deepEqual(get_warrant_tail(job_id), result.warrant.entries)

    const after = detach_job(job_id)
    assert.equal(after.attached, false)

    assert.throws(() => attach_job('missing'), (err: unknown) => err instanceof UnknownJobError)
  })
})
