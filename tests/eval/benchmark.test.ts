import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compressionScore } from '../../src/eval/metrics.ts'
import {
  aggregateBins,
  keyDecisionFileCandidates,
  parseKeyDecisions,
  scoreSample,
  scoredComposite,
  type ScoredSample,
  type ScoreSampleInput,
} from '../../src/eval/benchmark.ts'

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
    assert.notEqual(short.composite, long.composite)
    assert.equal(report.bins.multi_dead_end.mean_composite, null)
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
      JSON.stringify({ trace_id: 'claude-code:sess-no-llm', segment_ids: ['s0006', 's0007'] }),
    )
    assert.deepEqual(gold.segment_ids, ['s0006', 's0007'])
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
