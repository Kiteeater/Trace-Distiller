import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LIVE_PAGE_NOTICE, renderLiveHtml } from '../../src/report/live_page.ts'

const livePageSrc = join(dirname(fileURLToPath(import.meta.url)), '../../src/report/live_page.ts')

describe('renderLiveHtml', () => {
  it('renders progress cells, warrant tail, and Distiller-not-other-agent copy', () => {
    const html = renderLiveHtml({
      list_jobs: [{ job_id: 'job-1', trace_id: 't1', status: 'done', attached: false }],
      jobs: [
        {
          list_jobs: [{ job_id: 'job-1', trace_id: 't1', status: 'done', attached: false }],
          attach_job: { job_id: 'job-1', trace_id: 't1', status: 'done' },
          detach_job: { job_id: 'job-1', trace_id: 't1', status: 'done' },
          get_cut_progress: {
            job_id: 'job-1',
            trace_id: 't1',
            segment: 'done',
            rules: 'done',
            holes: 'skipped',
            assemble: 'done',
            compression_ratio: 0.21,
          },
          get_partial_result: {
            cards: [{ id: 'seg-keep', tool: 'Edit', head: 'export const add', sig: 'Edit:add.ts' }],
          },
          get_warrant_tail: [
            { segment_id: 'seg-keep', action: 'keep', source: { kind: 'rule', name: 'fail_closed_keep' } },
            { segment_id: 'seg-drop', action: 'drop', source: { kind: 'rule', name: 'repeat_read' } },
          ],
        },
      ],
    })
    assert.match(html, /data-stage="segment"/)
    assert.match(html, /data-stage="rules"/)
    assert.match(html, /data-stage="holes"/)
    assert.match(html, /data-stage="assemble"/)
    assert.match(html, /不是对方 agent/)
    assert.match(html, new RegExp(LIVE_PAGE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(html, /Distiller 裁剪过程/)
    assert.match(html, /Partial Playback/)
    assert.match(html, /id="live-data"/)
    assert.doesNotMatch(html, /send_message|interrupt|inject_prompt/)
    assert.doesNotMatch(html, /请先启动 server/)
    assert.doesNotMatch(html, /https?:\/\//)
  })

  it('is a pure renderer: no fs, fetch, sqlite, listen, or createServer', () => {
    const src = readFileSync(livePageSrc, 'utf8')
    assert.doesNotMatch(src, /from ['"]node:fs['"]/)
    assert.doesNotMatch(src, /\bfetch\s*\(/)
    assert.doesNotMatch(src, /sqlite/i)
    assert.doesNotMatch(src, /writeFile|readFile/)
    assert.doesNotMatch(src, /\.listen\s*\(/)
    assert.doesNotMatch(src, /createServer/)
    assert.doesNotMatch(src, /send_message|interrupt|inject_prompt/)
  })
})
