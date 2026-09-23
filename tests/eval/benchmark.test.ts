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
  it('deprecated composite stays compressionScore × recall × replay; fidelity does not', () => {
    const sample = scoreSample(passingInput())
    const expected = compressionScore(0.2) * 1 * 0.95
    assert.equal(sample.composite, expected)
    assert.equal(sample.m1_score, compressionScore(0.2) * 1)
    assert.equal(sample.fidelity, 1)
    assert.equal(sample.gold, 'independent')
    assert.equal(sample.metrics.key_step_recall.status, 'pass')
    assert.equal('compression_ratio' in sample.metrics, false)
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

  it('fidelity ignores fake replay and scales real verified replay', () => {
    const fake = scoreSample(passingInput({ replay: 0.2, replay_fidelity: 'fake' }))
    assert.equal(fake.fidelity, 1)
    assert.equal(fake.metrics.replay.status, 'observed')
    assert.equal(fake.composite, null)

    const unverified = scoreSample(passingInput({ replay: 0.2, replay_fidelity: 'unverified' }))
    assert.equal(unverified.fidelity, 1)

    const real = scoreSample(passingInput({ replay: 0.5, replay_fidelity: 'real', qa_solid: true }))
    assert.equal(real.fidelity, 0.5 * 0.9)
    assert.equal(real.metrics.replay.status, 'observed')
  })

  it('wide keep is not a gate fail and fidelity stays defined', () => {
    const wide = scoreSample(passingInput({ compression_ratio: 0.9 }))
    assert.equal(wide.fidelity, 1)
    assert.equal(wide.composite, null)
    assert.equal(wide.m1_score, null)
    assert.equal(wide.metrics.key_step_recall.status, 'pass')
    assert.equal(
      Object.values(wide.metrics).some((cell) => cell.status === 'fail'),
      false,
    )
  })

  it('cost ratio is observational; deprecated composite still uses the old cost gate', () => {
    const sample = scoreSample(
      passingInput({
        bin: 'long',
        original_tokens: 80_000,
        distill_cost_ratio: 1.62,
      }),
    )
    assert.equal(sample.metrics.distill_cost_ratio.status, 'observed')
    assert.equal(sample.metrics.distill_cost_ratio.value, 1.62)
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, compressionScore(0.2) * 1)
    assert.equal(sample.fidelity, 1)

    const short = scoreSample(
      passingInput({ bin: 'short', original_tokens: 500, distill_cost_ratio: 47.8 }),
    )
    assert.equal(short.metrics.distill_cost_ratio.status, 'observed')
    assert.equal(short.fidelity, 1)
    assert.ok(short.composite !== null && short.composite > 0)
  })

  it('QA hard-gates only when the case set is solid', () => {
    const skipped = scoreSample(passingInput({ qa: null }))
    assert.equal(skipped.metrics.qa.status, 'skipped')
    assert.equal(skipped.fidelity, 1)
    assert.equal(skipped.composite, null)

    const unmarked = scoreSample(passingInput({ qa: 0.1 }))
    assert.equal(unmarked.metrics.qa.status, 'observed')
    assert.equal(unmarked.fidelity, 1)

    const solidFail = scoreSample(passingInput({ qa: 0.1, qa_solid: true }))
    assert.equal(solidFail.metrics.qa.status, 'fail')
    assert.equal(solidFail.fidelity, 0.1)

    const solidPass = scoreSample(passingInput({ qa: 0.9, qa_solid: true }))
    assert.equal(solidPass.metrics.qa.status, 'pass')
    assert.equal(solidPass.fidelity, 0.9)

    const solidMissing = scoreSample(passingInput({ qa: null, qa_solid: true }))
    assert.equal(solidMissing.metrics.qa.status, 'skipped')
    assert.equal(solidMissing.fidelity, 1)
  })

  it('low recall nulls fidelity; coherence does not', () => {
    const lowRecall = scoreSample(passingInput({ gold_segment_ids: ['miss'] }))
    assert.equal(lowRecall.fidelity, null)
    assert.equal(lowRecall.metrics.key_step_recall.status, 'fail')
    assert.equal(lowRecall.composite, null)

    const lowCoherence = scoreSample(passingInput({ coherence_scores: [5, 5, 1] }))
    assert.equal(lowCoherence.fidelity, 1)
    assert.equal(lowCoherence.metrics.coherence.status, 'observed')
    assert.equal(lowCoherence.composite, null)

    const fullDelete = scoreSample(
      passingInput({ compression_ratio: 0, gold_segment_ids: ['a'], kept: [] }),
    )
    assert.equal(fullDelete.fidelity, null)
    assert.equal(fullDelete.metrics.key_step_recall.status, 'fail')
  })

  it('missing gold is skipped, not a hard fail', () => {
    const sample = scoreSample(passingInput({ gold_segment_ids: null }))
    assert.equal(sample.gold, 'skipped')
    assert.equal(sample.metrics.key_step_recall.status, 'skipped')
    assert.equal(sample.metrics.key_step_recall.value, null)
    assert.equal(sample.fidelity, null)
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, null)
    assert.equal(
      Object.values(sample.metrics).some((cell) => cell.status === 'fail'),
      false,
    )
  })

  it('wide keep without gold does not gate-fail', () => {
    const sample = scoreSample(
      passingInput({ gold_segment_ids: null, compression_ratio: 0.8, replay: null, qa: null, coherence_scores: null }),
    )
    assert.equal(sample.metrics.key_step_recall.status, 'skipped')
    assert.equal(sample.metrics.replay.status, 'skipped')
    assert.equal(sample.fidelity, null)
    assert.equal(sample.composite, null)
    assert.equal(sample.m1_score, null)
    assert.equal(
      Object.values(sample.metrics).some((cell) => cell.status === 'fail'),
      false,
    )
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
    assert.equal(report.bins.short.mean_fidelity, short.fidelity)
    assert.equal(report.bins.long.mean_fidelity, long.fidelity)
    assert.equal(short.fidelity, long.fidelity)
    assert.notEqual(short.composite, long.composite)
    assert.equal(report.bins.short.n_defined_composite, 1)
    assert.equal(report.bins.long.n_defined_composite, 1)
    assert.equal(report.bins.short.n_defined_fidelity, 1)
    assert.equal(report.bins.long.n_defined_fidelity, 1)
    assert.equal(report.bins.short.n_gate_fail, 0)
    assert.equal(report.bins.long.n_gate_fail, 0)
    assert.equal(report.bins.multi_dead_end.mean_composite, null)
    assert.equal(report.bins.multi_dead_end.mean_m1_score, null)
    assert.equal(report.bins.multi_dead_end.mean_fidelity, null)
    assert.equal(report.bins.multi_dead_end.n_defined_composite, 0)
    assert.equal(report.bins.multi_dead_end.n_defined_m1, 0)
    assert.equal(report.bins.multi_dead_end.n_defined_fidelity, 0)
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
    const wide = scoreSample(
      passingInput({ bin: 'short', trace_id: 'wide', compression_ratio: 0.95 }),
    )
    const report = aggregateBins([passing, failed, span, wide])
    const table = report.bins.short
    assert.equal(table.n, 4)
    assert.equal(table.n_defined_composite, 1)
    assert.equal(table.n_defined_m1, 1)
    assert.equal(table.n_defined_fidelity, 2)
    assert.equal(table.n_gate_fail, 2)
    assert.equal(table.mean_composite, passing.composite)
    assert.equal(table.mean_m1_score, passing.m1_score)
    assert.equal(table.mean_fidelity, 1)
    assert.equal(wide.fidelity, 1)
    assert.equal(failed.composite, null)
    assert.equal(failed.fidelity, null)
    assert.equal(failed.m1_score, null)
    assert.equal(failed.metrics.key_step_recall.status, 'fail')
    assert.equal(span.composite, null)
    assert.equal(span.fidelity, null)
    assert.equal(span.process_failed, true)
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
    assert.equal(gold.qa_solid, undefined)
    const solid = parseKeyDecisions(
      JSON.stringify({
        trace_id: 'claude-code:sess-no-llm',
        segment_ids: ['s0006'],
        qa_solid: true,
      }),
    )
    assert.equal(solid.qa_solid, true)
    assert.throws(
      () =>
        parseKeyDecisions(
          JSON.stringify({
            trace_id: 'claude-code:sess-no-llm',
            segment_ids: ['s0006'],
            qa_solid: 'yes',
          }),
        ),
      /qa_solid/,
    )
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
  it('records fidelity null on span failure without a compress gate', () => {
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
    assert.equal(sample.fidelity, null)
    assert.equal(sample.process_failed, true)
    assert.equal('compression_ratio' in sample.metrics, false)
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
