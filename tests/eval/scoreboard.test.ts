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
            gold: 'independent',
          },
        ],
      },
      long: { bin: 'long', n: 0, mean_composite: null, stddev_composite: null, samples: [] },
      multi_dead_end: {
        bin: 'multi_dead_end',
        n: 0,
        mean_composite: null,
        stddev_composite: null,
        samples: [],
      },
    }
    const md = renderScoreboardMarkdown({ dir: 'benchmark/datasets', mode: 'no_llm', l4: false, bins })
    assert.match(md, /## short/)
    assert.match(md, /t1/)
    assert.match(md, /never averaged/i)
    assert.doesNotMatch(md, /overall score/i)
  })
})
