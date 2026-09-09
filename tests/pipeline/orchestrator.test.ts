import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../../src/domain/cut_decision.ts'
import { distill, NotImplementedError } from '../../src/pipeline/orchestrator.ts'
import { applyRules } from '../../src/pipeline/rules.ts'
import { segment } from '../../src/pipeline/segmenter.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures/claude_code')
const pipelineSrc = join(here, '../../src/pipeline/orchestrator.ts')

function load(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

describe('orchestrator no_llm', () => {
  it('does not import pi or hole sessions; warrant comes from write_warrant', () => {
    const src = readFileSync(pipelineSrc, 'utf8')
    const imports = src
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line))
      .join('\n')
    assert.doesNotMatch(imports, /@mariozechner\/pi/)
    assert.doesNotMatch(imports, /createAgentSession/)
    assert.doesNotMatch(imports, /from ['"]pi['"]/)
    assert.doesNotMatch(imports, /skeleton_pass/)
    assert.doesNotMatch(imports, /label_window/)
    assert.match(imports, /agent\/sessions\/write_warrant/)
  })

  it('runs adapter fixture to plan + training/playback; resolved drop/collapse, unresolved keep', async () => {
    const raw = parse(load('no_llm_conservative.jsonl'))
    const ruled = applyRules({ view: segment(raw), raw })
    const out = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })

    assert.equal(out.plan.trace_id, raw.meta.trace_id)
    assert.equal(out.plan.profile_id, DEFAULT_CUT_PROFILE.id)
    assert.equal(out.training.trace_id, out.plan.trace_id)
    assert.equal(out.playback.trace_id, out.plan.trace_id)
    assert.equal(out.training.plan_ref, out.playback.plan_ref)
    assert.ok(out.training.turns.length > 0)
    assert.ok(out.playback.cards.length > 0)
    assert.equal(out.metrics_ref, '')

    const warrantIds = out.warrant.entries.map((e) => e.segment_id)
    assert.deepEqual(
      warrantIds,
      ruled.view.segments.map((s) => s.id),
    )

    assert.ok(ruled.decisions.some((d) => d.label === 'routine'))
    assert.ok(ruled.decisions.some((d) => d.label === 'dead_end'))
    assert.ok(ruled.unresolved_ids.length > 0)

    for (const d of ruled.decisions) {
      if (d.label === 'routine') {
        assert.equal(out.plan.dropped.includes(d.segment_id), true, d.segment_id)
        const entry = out.warrant.entries.find((e) => e.segment_id === d.segment_id)
        assert.equal(entry?.action, 'drop')
        assert.equal(entry?.source.kind, 'rule')
        assert.equal(entry?.source.name, d.rule_name)
      }
      if (d.label === 'dead_end') {
        assert.equal(
          out.plan.collapsed.some((c) => c.segment_id === d.segment_id),
          true,
          d.segment_id,
        )
        const entry = out.warrant.entries.find((e) => e.segment_id === d.segment_id)
        assert.equal(entry?.action, 'collapse')
        assert.ok((entry?.dead_end_summary ?? '').length > 0)
      }
    }

    for (const id of ruled.unresolved_ids) {
      assert.equal(out.plan.kept.includes(id), true, id)
      const entry = out.warrant.entries.find((e) => e.segment_id === id)
      assert.equal(entry?.action, 'keep')
      assert.equal(entry?.source.kind, 'rule')
      assert.equal(entry?.source.name, FAIL_CLOSED_KEEP_RULE)
    }

    const again = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })
    assert.equal(JSON.stringify(again.plan), JSON.stringify(out.plan))
    assert.equal(JSON.stringify(again.warrant), JSON.stringify(out.warrant))
  })

  it('throws NotImplementedError when mode is not no_llm', async () => {
    const raw = parse(load('single_task_pytest.jsonl'))
    await assert.rejects(
      () => distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'full' }),
      (err: unknown) =>
        err instanceof NotImplementedError && String(err.message).includes('full'),
    )
  })
})
