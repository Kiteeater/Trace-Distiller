import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compressionScore } from '../../src/eval/metrics.ts'
import {
  aggregateBins,
  failedBenchSample,
  keyDecisionFileCandidates,
  noteFromBenchDistillError,
  parseKeyDecisions,
  scoreSample,
  scoredComposite,
  type ScoredSample,
  type ScoreSampleInput,
} from '../../src/eval/benchmark.ts'
import { SpanFailure } from '../../src/domain/span_violation.ts'
import type { CutPlan } from '../../src/types/cut_plan.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/eval')
const pipelineDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/pipeline')
const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/agent/sessions')

function passingInput(over: Partial<ScoreSampleInput> = {}): ScoreSampleInput {
  return {
    bin: 'short',
    trace_id: 't1',
    compression_ratio: 0.2,
    distill_cost_ratio: 0.1,
    kept: ['s0006', 's0007'],
    gold_segment_ids: ['s0006', 's0007'],
    replay: 0.95,
    qa: 0.9,
    coherence_scores: [4, 5, 4],
    ...over,
  }
}

describe('benchmark multiplicative score', () => {
  it('Score = compressionScore × recall × replay when all six pass', () => {
    const sample = scoreSample(passingInput())
    const expected = compressionScore(0.2) * 1 * 0.95
    assert.equal(sample.composite, expected)
    assert.equal(sample.m1_score, compressionScore(0.2) * 1)
    assert.equal(sample.gold, 'independent')
    assert.equal(sample.metrics.key_step_recall.status, 'pass')
    assert.equal(
      scoredComposite({
        compression_ratio: 0.2,
        key_step_recall: 1,
        replay: 0.95,
        qa: 0.9,
        coherence_scores: [4, 5, 4],
        distill_cost_ratio: 0.1,
      }),
      expected,
    )
  })

  it('m1_score survives cost fail while composite zeros', () => {
    const sample = scoreSample(
      passingInput({
        bin: 'long',
        original_tokens: 80_000,
        distill_cost_ratio: 1.62,
      }),
    )
    assert.equal(sample.metrics.distill_cost_ratio.status, 'fail')
    assert.equal(sample.composite, 0)
    assert.equal(sample.m1_score, compressionScore(0.2) * 1)
    assert.ok(sample.m1_score! > 0)
  })

  it('short / small original_tokens: cost reported but does not fail composite', () => {
    const short = scoreSample(
      passingInput({ bin: 'short', original_tokens: 500, distill_cost_ratio: 47.8 }),
    )
    assert.equal(short.metrics.distill_cost_ratio.status, 'pass')
    assert.equal(short.metrics.distill_cost_ratio.value, 47.8)
    assert.ok(short.composite !== null && short.composite > 0)

    const smallLong = scoreSample(
      passingInput({
        bin: 'long',
        original_tokens: 10_000,
        distill_cost_ratio: 0.9,
      }),
    )
    assert.equal(smallLong.metrics.distill_cost_ratio.status, 'pass')
    assert.ok(smallLong.composite !== null && smallLong.composite > 0)
  })

  it('QA 0/0 (null) is skipped, not a composite fail', () => {
    const sample = scoreSample(passingInput({ qa: null }))
    assert.equal(sample.metrics.qa.status, 'skipped')
    assert.equal(sample.composite, null)
  })

  it('one failing metric zeros the composite even if others look good', () => {
    assert.equal(scoreSample(passingInput({ replay: 0.1 })).composite, 0)
    assert.equal(scoreSample(passingInput({ qa: 0.1 })).composite, 0)
    assert.equal(scoreSample(passingInput({ compression_ratio: 0.9 })).composite, 0)
    assert.equal(scoreSample(passingInput({ gold_segment_ids: ['miss'] })).composite, 0)
    assert.equal(
      scoreSample(passingInput({ coherence_scores: [5, 5, 1] })).composite,
      0,
      'coherence floor < 2 fails even with a high mean',
    )
    assert.equal(scoreSample(passingInput({ compression_ratio: 1 })).composite, 0, 'full keep')
    assert.equal(
      scoreSample(passingInput({ compression_ratio: 0, gold_segment_ids: ['a'], kept: [] })).composite,
      0,
      'full delete',
    )
  })

  it('missing gold is skipped, not a hard fail (M1)', () => {
    const sample = scoreSample(passingInput({ gold_segment_ids: null }))
    assert.equal(sample.gold, 'skipped')
    assert.equal(sample.metrics.key_step_recall.status, 'skipped')
    assert.equal(sample.metrics.key_step_recall.value, null)
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, null)
  })

  it('a present fail still zeros the score when gold is skipped', () => {
    const sample = scoreSample(
      passingInput({ gold_segment_ids: null, compression_ratio: 0.8, replay: null, qa: null, coherence_scores: null }),
    )
    assert.equal(sample.metrics.key_step_recall.status, 'skipped')
    assert.equal(sample.metrics.replay.status, 'skipped')
    assert.equal(sample.metrics.compression_ratio.status, 'fail')
    assert.equal(sample.composite, 0)
  })
})

describe('benchmark bins are not averaged together', () => {
  it('reports three tracks separately with no overall/combined mean', () => {
    const short: ScoredSample = scoreSample(
      passingInput({ bin: 'short', trace_id: 's', compression_ratio: 0.15, replay: 1, gold_segment_ids: ['k'], kept: ['k'] }),
    )
    const long: ScoredSample = scoreSample(
      passingInput({
        bin: 'long',
        trace_id: 'l',
        compression_ratio: 0.25,
        replay: 0.9,
        gold_segment_ids: ['k'],
        kept: ['k'],
      }),
    )
    const report = aggregateBins([short, long])
    assert.equal(report.bins.short.n, 1)
    assert.equal(report.bins.long.n, 1)
    assert.equal(report.bins.multi_dead_end.n, 0)
    assert.equal(report.bins.short.mean_composite, short.composite)
    assert.equal(report.bins.long.mean_composite, long.composite)
    assert.equal(report.bins.short.mean_m1_score, short.m1_score)
    assert.equal(report.bins.long.mean_m1_score, long.m1_score)
    assert.notEqual(short.composite, long.composite)
    assert.equal(report.bins.multi_dead_end.mean_composite, null)
    assert.equal(report.bins.multi_dead_end.mean_m1_score, null)
    const keys = Object.keys(report.bins)
    assert.deepEqual(keys, ['short', 'long', 'multi_dead_end'])
    assert.equal('overall' in report, false)
    assert.equal('combined' in report, false)
    assert.equal('mean' in report, false)
    const dumped = JSON.stringify(report)
    assert.doesNotMatch(dumped, /"overall"/)
    const crossMean = ((short.composite ?? 0) + (long.composite ?? 0)) / 2
    assert.notEqual(report.bins.short.mean_composite, crossMean)
    assert.notEqual(report.bins.long.mean_composite, crossMean)
  })
})

describe('independent gold', () => {
  it('parses key-decisions.json and prefers data/raw path', () => {
    const gold = parseKeyDecisions(
      JSON.stringify({
        trace_id: 'claude-code:sess-no-llm',
        segment_ids: ['s0006', 's0007'],
        intent_text: 'Fix add',
        skeleton_segment_ids: ['s0006'],
      }),
    )
    assert.deepEqual(gold.segment_ids, ['s0006', 's0007'])
    assert.equal(gold.intent_text, 'Fix add')
    assert.deepEqual(gold.skeleton_segment_ids, ['s0006'])
    const paths = keyDecisionFileCandidates({
      trace_id: 'claude-code:sess-no-llm',
      cwd: '/repo',
      jsonl_path: '/repo/benchmark/datasets/short/add-fix.jsonl',
    })
    assert.equal(paths[0], '/repo/data/raw/claude-code:sess-no-llm.key-decisions.json')
    assert.ok(paths.some((p) => p.endsWith('add-fix.key-decisions.json')))
  })

  it('eval/benchmark does not import LabelDecision; pipeline/sessions do not read gold files', () => {
    const benchSrc = readFileSync(join(evalDir, 'benchmark.ts'), 'utf8')
    assert.doesNotMatch(benchSrc, /from ['"].*label_decision/)
    for (const name of ['orchestrator.ts', 'rules.ts', 'assembler.ts', 'segmenter.ts']) {
      const src = readFileSync(join(pipelineDir, name), 'utf8')
      assert.doesNotMatch(src, /key-decisions/)
    }
    for (const name of [
      'cut_brain.ts',
      'cut_brain_harness.ts',
      'label_window.ts',
      'skeleton_pass.ts',
      'write_warrant.ts',
      'open_session.ts',
    ]) {
      const src = readFileSync(join(sessionsDir, name), 'utf8')
      assert.doesNotMatch(src, /key-decisions/)
    }
  })
})

describe('failedBenchSample / noteFromBenchDistillError', () => {
  it('records composite 0 with compression fail and span_failure note', () => {
    const plan: CutPlan = {
      trace_id: 't-fail',
      profile_id: 'default',
      warrant_ref: 'w',
      kept: ['a', 'b'],
      collapsed: [],
      dropped: ['x'],
      span_ok: false,
      span_violations: ['span:a:b'],
    }
    const err = new SpanFailure(plan, [
      {
        id: 'span:a:b',
        left_segment_id: 'a',
        right_segment_id: 'b',
        gap_segments: 5,
        reason: 'gap_too_large',
      },
    ])
    const note = noteFromBenchDistillError(err)
    assert.match(note, /^span_failure:/)
    assert.match(note, /gap_too_large:a->b:gap=5/)
    const sample = failedBenchSample({
      bin: 'long',
      trace_id: 't-fail',
      notes: [note],
    })
    assert.equal(sample.composite, 0)
    assert.equal(sample.m1_score, null)
    assert.equal(sample.metrics.compression_ratio.value, null)
    assert.equal(sample.metrics.compression_ratio.status, 'fail')
    assert.equal(sample.gold, 'skipped')
    assert.deepEqual(sample.notes, [note])
  })

  it('prefixes other distill errors as distill_error:', () => {
    assert.equal(noteFromBenchDistillError(new Error('boom')), 'distill_error:boom')
  })
})
