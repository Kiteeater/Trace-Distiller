import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/adapters/claude_code.ts'
import { DEFAULT_CUT_PROFILE } from '../../src/constant/compression.ts'
import { insertLabelDecisions, listLabels, ruleCoverage } from '../../src/data/data_label.ts'
import { getMetrics, insertMetrics } from '../../src/data/data_metric.ts'
import {
  getTraceMeta,
  listSegments,
  openDb,
  replaceSegments,
  runInTransaction,
  upsertTraceMeta,
} from '../../src/data/data_segment.ts'
import { getCutPlan, insertCutPlan, insertWarrant, listWarrants } from '../../src/data/data_warrant.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../../src/domain/cut_decision.ts'
import { distill } from '../../src/pipeline/orchestrator.ts'
import { AdmissionError } from '../../src/types/raw_trace.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/claude_code')
const pipelineDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/pipeline')
const agentDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/agent')

describe('data sqlite', () => {
  it('writes a distill result and reads it back; ruleCoverage matches labels', async () => {
    const raw = parse(readFileSync(join(fixtures, 'no_llm_conservative.jsonl'), 'utf8'))
    const out = await distill({ raw, profile: DEFAULT_CUT_PROFILE, mode: 'no_llm' })
    const db = openDb(':memory:')
    try {
      runInTransaction(db, () => {
        upsertTraceMeta(db, raw)
        replaceSegments(db, raw.meta.trace_id, out.view.segments)
        insertLabelDecisions(db, raw.meta.trace_id, out.decisions)
        insertWarrant(db, out.warrant)
        insertCutPlan(db, out.plan)
        insertMetrics(db, {
          trace_id: raw.meta.trace_id,
          compression_ratio: 0.2,
          distill_cost_ratio: 0,
          key_step_recall: null,
          replay: null,
          qa: null,
          coherence: null,
          composite: null,
        })
      })

      const meta = getTraceMeta(db, raw.meta.trace_id)
      assert.equal(meta?.trace_id, raw.meta.trace_id)
      assert.equal(meta?.ground_truth_ref, raw.meta.ground_truth_ref)
      assert.equal(meta?.total_tokens, raw.meta.total_tokens)

      const segs = listSegments(db, raw.meta.trace_id)
      assert.equal(segs.length, out.view.segments.length)
      assert.deepEqual(
        segs.map((s) => s.segment_id),
        out.view.segments.map((s) => s.id),
      )
      assert.deepEqual(segs[0]?.raw_refs, out.view.segments[0]?.raw_refs)

      const labels = listLabels(db, raw.meta.trace_id)
      assert.equal(labels.length, out.decisions.length)
      assert.equal(labels.some((l) => l.label === 'routine'), true)
      assert.equal(labels.some((l) => l.source_kind === 'rule'), true)

      const warrants = listWarrants(db, raw.meta.trace_id)
      assert.equal(warrants.length, out.warrant.entries.length)
      assert.equal(
        warrants.filter((w) => w.source_name === FAIL_CLOSED_KEEP_RULE).length,
        out.unresolved_ids.length,
      )

      const plan = getCutPlan(db, raw.meta.trace_id)
      assert.equal(plan?.profile_id, out.plan.profile_id)
      assert.deepEqual(plan?.dropped, out.plan.dropped)
      assert.equal(plan?.span_ok, true)

      const metrics = getMetrics(db, raw.meta.trace_id)
      assert.equal(metrics?.compression_ratio, 0.2)
      assert.equal(metrics?.key_step_recall, null)

      const coverage = ruleCoverage(db, raw.meta.trace_id)
      assert.equal(coverage.total, out.view.segments.length)
      assert.equal(coverage.ruled, out.decisions.length)
      assert.equal(coverage.llm, 0)
      assert.equal(coverage.fail_closed, out.unresolved_ids.length)
    } finally {
      db.close()
    }
  })

  it('rejects inserting a trace with empty ground_truth_ref', () => {
    const db = openDb(':memory:')
    try {
      const raw = parse(readFileSync(join(fixtures, 'single_task_pytest.jsonl'), 'utf8'))
      raw.meta.ground_truth_ref = ''
      assert.throws(
        () => upsertTraceMeta(db, raw),
        (err: unknown) => err instanceof AdmissionError && err.code === 'no_ground_truth',
      )
      assert.equal(getTraceMeta(db, raw.meta.trace_id), undefined)
    } finally {
      db.close()
    }
  })

  it('does not mention sqlite in pipeline or agent sources', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (name.endsWith('.ts')) files.push(p)
      }
    }
    walk(pipelineDir)
    walk(agentDir)
    for (const file of files) {
      const imports = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*import\s/.test(line))
        .join('\n')
      assert.doesNotMatch(imports, /sqlite/i, file)
    }
  })
})
