import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderScoreboardMarkdown } from '../../src/eval/scoreboard.ts'
import type { BenchmarkBin, BenchmarkReport, BinTable } from '../../src/eval/benchmark.ts'

function emptyBin(bin: BenchmarkBin): BinTable {
  return {
    bin,
    n: 0,
    mean_fidelity: null,
    stddev_fidelity: null,
    n_defined_fidelity: 0,
    mean_composite: null,
    stddev_composite: null,
    n_defined_composite: 0,
    mean_m1_score: null,
    stddev_m1_score: null,
    n_defined_m1: 0,
    n_gate_fail: 0,
    mean_hole_a_efficiency: null,
    stddev_hole_a_efficiency: null,
    mean_roi: null,
    stddev_roi: null,
    n_defined_roi: 0,
    samples: [],
  }
}

describe('scoreboard markdown', () => {
  it('renders per-bin tables without overall', () => {
    const bins: BenchmarkReport['bins'] = {
      short: {
        bin: 'short',
        n: 1,
        mean_fidelity: 1,
        stddev_fidelity: 0,
        n_defined_fidelity: 1,
        mean_composite: 10,
        stddev_composite: 0,
        n_defined_composite: 1,
        mean_m1_score: 80,
        stddev_m1_score: 0,
        n_defined_m1: 1,
        n_gate_fail: 0,
        mean_hole_a_efficiency: 0.42,
        stddev_hole_a_efficiency: 0,
        mean_roi: 10,
        stddev_roi: 0,
        n_defined_roi: 1,
        samples: [
          {
            trace_id: 't1',
            bin: 'short',
            metrics: {
              key_step_recall: { value: 1, status: 'pass' },
              replay: { value: 1, status: 'observed' },
              qa: { value: 0.9, status: 'observed' },
              coherence: { value: 4.5, status: 'observed' },
              distill_cost_ratio: { value: 0.1, status: 'observed' },
            },
            fidelity: 1,
            replay_fidelity: 'absent',
            qa_solid: false,
            process_failed: false,
            composite: 60,
            m1_score: 80,
            gold: 'independent',
            distill_tokens: 100,
            sft_saved: 1000,
            roi: 10,
            hole_a_vector: {
              quality: 1,
              cosine: 1,
              skeleton_recall: null,
              tokens: 10,
              segments_read: 2,
              cost: 10,
              efficiency: 0.42,
              embedding: 'deterministic_hash',
            },
          },
        ],
      },
      long: emptyBin('long'),
      multi_dead_end: emptyBin('multi_dead_end'),
    }
    const md = renderScoreboardMarkdown({ dir: 'benchmark/datasets', mode: 'with_llm', l4: false, bins })
    assert.match(md, /## short/)
    assert.match(md, /t1/)
    assert.match(md, /never averaged/i)
    assert.match(md, /m1_score/)
    assert.match(md, /\| fidelity \|/)
    assert.match(md, /\| a_eff \|/)
    assert.match(md, /\| roi \|/)
    assert.match(md, /\| distill_tokens \|/)
    assert.match(md, /\| sft_saved \|/)
    assert.match(md, /mean fidelity=1\.000 \(defined=1\)/)
    assert.match(md, /mean a_eff=/)
    assert.match(md, /mean roi=10\.00 \(defined=1\)/)
    assert.match(md, /defined=1/)
    assert.match(md, /gate fails=0/)
    assert.match(md, /0\.420/)
    assert.match(md, /ADR-0011 b/)
    assert.match(md, /ADR-0014/)
    assert.match(md, /ADR-0015/)
    assert.match(md, /ADR-0018/)
    assert.match(md, /utility-report/)
    assert.match(md, /1×1/)
    assert.doesNotMatch(md, /\| compress \|/)
    assert.doesNotMatch(md, /\| composite \|/)
    assert.doesNotMatch(md, /\| m1 \|/)
    assert.doesNotMatch(md, /overall score/i)
    assert.doesNotMatch(md, /hard-?zero/i)
    assert.doesNotMatch(md, /fail → 0/)
  })

  it('renders undefined fidelity as em dash, not zero', () => {
    const bins: BenchmarkReport['bins'] = {
      short: {
        bin: 'short',
        n: 1,
        mean_fidelity: null,
        stddev_fidelity: null,
        n_defined_fidelity: 0,
        mean_composite: null,
        stddev_composite: null,
        n_defined_composite: 0,
        mean_m1_score: null,
        stddev_m1_score: null,
        n_defined_m1: 0,
        n_gate_fail: 1,
        mean_hole_a_efficiency: null,
        stddev_hole_a_efficiency: null,
        mean_roi: null,
        stddev_roi: null,
        n_defined_roi: 0,
        samples: [
          {
            trace_id: 't-fail',
            bin: 'short',
            metrics: {
              key_step_recall: { value: 0.5, status: 'fail' },
              replay: { value: 1, status: 'observed' },
              qa: { value: 0.9, status: 'observed' },
              coherence: { value: 4.5, status: 'observed' },
              distill_cost_ratio: { value: 0.1, status: 'observed' },
            },
            fidelity: null,
            replay_fidelity: 'fake',
            qa_solid: false,
            process_failed: false,
            composite: null,
            m1_score: null,
            gold: 'independent',
            distill_tokens: null,
            sft_saved: null,
            roi: null,
          },
        ],
      },
      long: emptyBin('long'),
      multi_dead_end: emptyBin('multi_dead_end'),
    }
    const md = renderScoreboardMarkdown({ dir: 'benchmark/datasets', mode: 'with_llm', l4: false, bins })
    assert.match(md, /t-fail/)
    assert.match(md, /0\.500 \(f\)/)
    assert.match(md, /mean fidelity=— \(defined=0\)/)
    assert.match(md, /mean roi=— \(defined=0\)/)
    assert.match(md, /gate fails=1/)
    assert.match(md, /\| t-fail \|.*\| — \|/)
    assert.doesNotMatch(md, /\| compress \|/)
    assert.doesNotMatch(md, /\| t-fail \|.*\| 0\.00 \|/)
  })
})
