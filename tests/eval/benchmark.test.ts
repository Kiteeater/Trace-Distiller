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

  it('m1_score survives cost fail while composite stays undefined', () => {
    const sample = scoreSample(
      passingInput({
        bin: 'long',
        original_tokens: 80_000,
        distill_cost_ratio: 1.62,
      }),
    )
    assert.equal(sample.metrics.distill_cost_ratio.status, 'fail')
    assert.equal(sample.composite, null)
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

  it('one failing metric leaves composite undefined even if others look good', () => {
    assert.equal(scoreSample(passingInput({ replay: 0.1 })).composite, null)
    assert.equal(scoreSample(passingInput({ qa: 0.1 })).composite, null)
    assert.equal(scoreSample(passingInput({ compression_ratio: 0.9 })).composite, null)
    assert.equal(scoreSample(passingInput({ gold_segment_ids: ['miss'] })).composite, null)
    assert.equal(
      scoreSample(passingInput({ coherence_scores: [5, 5, 1] })).composite,
      null,
      'coherence floor < 2 fails even with a high mean',
    )
    assert.equal(scoreSample(passingInput({ compression_ratio: 1 })).composite, null, 'full keep')
    assert.equal(
      scoreSample(passingInput({ compression_ratio: 0, gold_segment_ids: ['a'], kept: [] })).composite,
      null,
      'full delete',
    )
    const compressFail = scoreSample(passingInput({ compression_ratio: 0.9 }))
    assert.equal(compressFail.metrics.compression_ratio.status, 'fail')
    assert.equal(compressFail.m1_score, null)
  })

  it('missing gold is skipped, not a hard fail (M1)', () => {
    const sample = scoreSample(passingInput({ gold_segment_ids: null }))
    assert.equal(sample.gold, 'skipped')
    assert.equal(sample.metrics.key_step_recall.status, 'skipped')
    assert.equal(sample.metrics.key_step_recall.value, null)
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, null)
  })

  it('a present fail leaves composite undefined when gold is skipped', () => {
    const sample = scoreSample(
      passingInput({ gold_segment_ids: null, compression_ratio: 0.8, replay: null, qa: null, coherence_scores: null }),
    )
    assert.equal(sample.metrics.key_step_recall.status, 'skipped')
    assert.equal(sample.metrics.replay.status, 'skipped')
    assert.equal(sample.metrics.compression_ratio.status, 'fail')
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, null)
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
    assert.equal(report.bins.short.n_defined_composite, 1)
    assert.equal(report.bins.long.n_defined_composite, 1)
    assert.equal(report.bins.short.n_gate_fail, 0)
    assert.equal(report.bins.long.n_gate_fail, 0)
    assert.equal(report.bins.multi_dead_end.mean_composite, null)
    assert.equal(report.bins.multi_dead_end.mean_m1_score, null)
    assert.equal(report.bins.multi_dead_end.n_defined_composite, 0)
    assert.equal(report.bins.multi_dead_end.n_defined_m1, 0)
    assert.equal(report.bins.multi_dead_end.n_defined_roi, 0)
    assert.equal(report.bins.multi_dead_end.mean_roi, null)
    assert.equal(report.bins.multi_dead_end.n_gate_fail, 0)
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

  it('means skip undefined scores; gate-fail count is separate', () => {
    const passing = scoreSample(passingInput({ bin: 'short', trace_id: 'ok' }))
    const failed = scoreSample(
      passingInput({
        bin: 'short',
        trace_id: 'fail-recall',
        gold_segment_ids: ['miss'],
        kept: ['s0006'],
      }),
    )
    const span = failedBenchSample({
      bin: 'short',
      trace_id: 'span',
      notes: ['span_failure:gap'],
    })
    const report = aggregateBins([passing, failed, span])
    const table = report.bins.short
    assert.equal(table.n, 3)
    assert.equal(table.n_defined_composite, 1)
    assert.equal(table.n_defined_m1, 1)
    assert.equal(table.n_gate_fail, 2)
    assert.equal(table.mean_composite, passing.composite)
    assert.equal(table.mean_m1_score, passing.m1_score)
    assert.equal(failed.composite, null)
    assert.equal(failed.m1_score, null)
    assert.equal(failed.metrics.key_step_recall.status, 'fail')
    assert.equal(span.composite, null)
    assert.equal(span.metrics.compression_ratio.status, 'fail')
    assert.equal(span.distill_tokens, null)
    assert.equal(span.sft_saved, null)
    assert.equal(span.roi, null)
  })

  it('ROI is column + mean of defined; not a composite gate', () => {
    const profitable = scoreSample(
      passingInput({
        bin: 'short',
        trace_id: 'profit',
        hole_a_plus_b_tokens: 50,
        original_tokens: 1000,
        training_cut_tokens: 200,
      }),
    )
    const spentZero = scoreSample(
      passingInput({
        bin: 'short',
        trace_id: 'fake-zero-spend',
        hole_a_plus_b_tokens: 0,
        original_tokens: 1000,
        training_cut_tokens: 200,
      }),
    )
    const noSave = scoreSample(
      passingInput({
        bin: 'short',
        trace_id: 'no-save',
        hole_a_plus_b_tokens: 40,
        original_tokens: 100,
        training_cut_tokens: 100,
      }),
    )
    assert.equal(profitable.distill_tokens, 50)
    assert.equal(profitable.sft_saved, 800)
    assert.equal(profitable.roi, 16)
    assert.ok(profitable.composite !== null)
    assert.equal(spentZero.distill_tokens, 0)
    assert.equal(spentZero.sft_saved, 800)
    assert.equal(spentZero.roi, null)
    assert.ok(spentZero.composite !== null)
    assert.equal(noSave.sft_saved, 0)
    assert.equal(noSave.roi, 0)
    const report = aggregateBins([profitable, spentZero, noSave])
    const table = report.bins.short
    assert.equal(table.n_defined_roi, 2)
    assert.equal(table.mean_roi, (16 + 0) / 2)
    assert.equal(spentZero.composite, profitable.composite)
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
  it('records composite null with compression fail and span_failure note', () => {
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
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, null)
    assert.equal(sample.metrics.compression_ratio.value, null)
    assert.equal(sample.metrics.compression_ratio.status, 'fail')
    assert.equal(sample.gold, 'skipped')
    assert.deepEqual(sample.notes, [note])
    assert.equal(sample.distill_tokens, null)
    assert.equal(sample.sft_saved, null)
    assert.equal(sample.roi, null)
  })

  it('prefixes other distill errors as distill_error:', () => {
    assert.equal(noteFromBenchDistillError(new Error('boom')), 'distill_error:boom')
  })
})
