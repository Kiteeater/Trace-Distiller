import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHtml, type ReportModel } from '../../src/report/html.ts'

const reportSrc = join(dirname(fileURLToPath(import.meta.url)), '../../src/report/html.ts')

describe('renderHtml', () => {
  it('embeds compression, coverage, and a drop source without IO APIs', () => {
    const model: ReportModel = {
      meta: {
        trace_id: 'claude-code:demo',
        source: 'claude-code',
        ground_truth_ref: 'turn:gt',
        total_tokens: 1000,
      },
      intent: { version: 0, text: 'fix add', scenario: 'implement' },
      original_step_count: 12,
      kept_step_count: 4,
      segments: [
        {
          id: 'seg-drop',
          tool: 'Read',
          sig: 'Read:add.ts',
          outcome: 'ok',
          rep_of: null,
          reads: ['add.ts'],
          writes: [],
          tokens: 10,
          focus: 'line',
          head: 'repeat read add.ts',
          raw_refs: ['t1'],
        },
        {
          id: 'seg-keep',
          tool: 'Edit',
          sig: 'Edit:add.ts',
          outcome: 'ok',
          rep_of: null,
          reads: [],
          writes: ['add.ts'],
          tokens: 20,
          focus: 'card',
          head: 'export const add',
          raw_refs: ['t2'],
        },
      ],
      playback: {
        trace_id: 'claude-code:demo',
        plan_ref: 'plan',
        cards: [
          {
            id: 'seg-keep',
            tool: 'Edit',
            sig: 'Edit:add.ts',
            outcome: 'ok',
            rep_of: null,
            reads: [],
            writes: ['add.ts'],
            tokens: 20,
            focus: 'card',
            head: 'export const add',
            raw_refs: ['t2'],
          },
        ],
        collapsed: [{ segment_id: 'seg-dead', summary: 'tried pytest, failed' }],
      },
      warrant: {
        trace_id: 'claude-code:demo',
        entries: [
          {
            segment_id: 'seg-drop',
            action: 'drop',
            source: { kind: 'rule', name: 'repeat_read' },
            confidence: 1,
          },
          {
            segment_id: 'seg-keep',
            action: 'keep',
            source: { kind: 'rule', name: 'fail_closed_keep' },
            confidence: 1,
          },
          {
            segment_id: 'seg-dead',
            action: 'collapse',
            source: { kind: 'rule', name: 'failed_call_no_followup' },
            confidence: 0.9,
            dead_end_summary: 'tried pytest, failed',
          },
        ],
      },
      labels: [
        {
          segment_id: 'seg-drop',
          label: 'routine',
          source: { kind: 'rule', name: 'repeat_read' },
          confidence: 1,
          rule_name: 'repeat_read',
        },
      ],
      coverage: { total: 12, ruled: 8, llm: 0, fail_closed: 4 },
      metrics: {
        compression_ratio: 0.22,
        distill_cost_ratio: 0,
        llm_segment_fraction: 0,
      },
    }

    const html = renderHtml(model)
    assert.match(html, /data-compression-ratio="0\.22"/)
    assert.match(html, />0\.22</)
    assert.match(html, /data-ruled="8"/)
    assert.match(html, /repeat_read/)
    assert.match(html, /id="hero"/)
    assert.match(html, /id="original-index"/)
    assert.match(html, /id="playback-seq"/)
    assert.match(html, /id="cut-detail"/)
    assert.match(html, /id="coverage"/)
    assert.match(html, /未跑 eval/)
    assert.doesNotMatch(html, /https?:\/\//)
    assert.doesNotMatch(html, /请先启动 server/)
    assert.match(html, /<script type="application\/json" id="report-data">/)
  })

  it('is a pure renderer: source has no fs, fetch, or sqlite', () => {
    const src = readFileSync(reportSrc, 'utf8')
    assert.doesNotMatch(src, /from ['"]node:fs['"]/)
    assert.doesNotMatch(src, /\bfetch\s*\(/)
    assert.doesNotMatch(src, /sqlite/i)
    assert.doesNotMatch(src, /writeFile|readFile/)
  })
})
