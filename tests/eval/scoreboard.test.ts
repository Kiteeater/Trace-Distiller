import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderScoreboardMarkdown } from '../../src/eval/scoreboard.ts'
import type { BenchmarkReport } from '../../src/eval/benchmark.ts'

describe('scoreboard markdown', () => {
  it('renders per-bin tables without overall', () => {
    const bins: BenchmarkReport['bins'] = {
      short: {
        bin: 'short',
        n: 1,
        mean_composite: 10,
        stddev_composite: 0,
        n_defined_composite: 1,
        mean_m1_score: 80,
        stddev_m1_score: 0,
        n_defined_m1: 1,
        n_gate_fail: 0,
        mean_hole_a_efficiency: 0.42,
        stddev_hole_a_efficiency: 0,
        samples: [
          {
            trace_id: 't1',
            bin: 'short',
            metrics: {
              compression_ratio: { value: 0.2, status: 'pass' },
              key_step_recall: { value: 1, status: 'pass' },
              replay: { value: 1, status: 'pass' },
              qa: { value: 0.9, status: 'pass' },
              coherence: { value: 4.5, status: 'pass' },
              distill_cost_ratio: { value: 0.1, status: 'pass' },
            },
            composite: 60,
            m1_score: 80,
            gold: 'independent',
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
      long: {
        bin: 'long',
        n: 0,
        mean_composite: null,
        stddev_composite: null,
        n_defined_composite: 0,
        mean_m1_score: null,
        stddev_m1_score: null,
        n_defined_m1: 0,
        n_gate_fail: 0,
        mean_hole_a_efficiency: null,
        stddev_hole_a_efficiency: null,
        samples: [],
      },
      multi_dead_end: {
        bin: 'multi_dead_end',
        n: 0,
        mean_composite: null,
        stddev_composite: null,
        n_defined_composite: 0,
        mean_m1_score: null,
        stddev_m1_score: null,
        n_defined_m1: 0,
        n_gate_fail: 0,
        mean_hole_a_efficiency: null,
        stddev_hole_a_efficiency: null,
        samples: [],
      },
    }
    const md = renderScoreboardMarkdown({ dir: 'benchmark/datasets', mode: 'with_llm', l4: false, bins })
    assert.match(md, /## short/)
    assert.match(md, /t1/)
    assert.match(md, /never averaged/i)
    assert.match(md, /m1_score/)
    assert.match(md, /\| m1 \|/)
    assert.match(md, /\| a_eff \|/)
    assert.match(md, /mean m1=/)
    assert.match(md, /mean a_eff=/)
    assert.match(md, /defined=1/)
    assert.match(md, /gate fails=0/)
    assert.match(md, /0\.420/)
    assert.match(md, /ADR-0011 b/)
    assert.match(md, /ADR-0014/)
    assert.doesNotMatch(md, /overall score/i)
    assert.doesNotMatch(md, /hard-?zero/i)
    assert.doesNotMatch(md, /fail → 0/)
  })

  it('renders undefined composite/m1 as em dash, not zero', () => {
    const bins: BenchmarkReport['bins'] = {
      short: {
        bin: 'short',
        n: 1,
        mean_composite: null,
        stddev_composite: null,
        n_defined_composite: 0,
        mean_m1_score: null,
        stddev_m1_score: null,
        n_defined_m1: 0,
        n_gate_fail: 1,
        mean_hole_a_efficiency: null,
        stddev_hole_a_efficiency: null,
        samples: [
          {
            trace_id: 't-fail',
            bin: 'short',
            metrics: {
              compression_ratio: { value: 0.9, status: 'fail' },
              key_step_recall: { value: 1, status: 'pass' },
              replay: { value: 1, status: 'pass' },
              qa: { value: 0.9, status: 'pass' },
              coherence: { value: 4.5, status: 'pass' },
              distill_cost_ratio: { value: 0.1, status: 'pass' },
            },
            composite: null,
            m1_score: null,
            gold: 'independent',
          },
        ],
      },
      long: {
        bin: 'long',
        n: 0,
        mean_composite: null,
        stddev_composite: null,
        n_defined_composite: 0,
        mean_m1_score: null,
        stddev_m1_score: null,
        n_defined_m1: 0,
        n_gate_fail: 0,
        mean_hole_a_efficiency: null,
        stddev_hole_a_efficiency: null,
        samples: [],
      },
      multi_dead_end: {
        bin: 'multi_dead_end',
        n: 0,
        mean_composite: null,
        stddev_composite: null,
        n_defined_composite: 0,
        mean_m1_score: null,
        stddev_m1_score: null,
        n_defined_m1: 0,
        n_gate_fail: 0,
        mean_hole_a_efficiency: null,
        stddev_hole_a_efficiency: null,
        samples: [],
      },
    }
    const md = renderScoreboardMarkdown({ dir: 'benchmark/datasets', mode: 'with_llm', l4: false, bins })
    assert.match(md, /t-fail/)
    assert.match(md, /0\.900 \(f\)/)
    assert.match(md, /mean composite=— \(defined=0\)/)
    assert.match(md, /mean m1=— \(defined=0\)/)
    assert.match(md, /gate fails=1/)
    assert.match(md, /\| t-fail \|.*\| — \| — \|/)
    assert.doesNotMatch(md, /\| t-fail \|.*\| 0\.00 \|/)
  })
})
