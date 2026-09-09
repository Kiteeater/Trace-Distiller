import type { TraceId } from '../types/raw_trace.ts'
import { asNumber, asString, type Db } from './data_segment.ts'

/** OPEN schema：评测六项未跑 eval 时为 NULL。蒸馏汇总数字在 distill 时写入。 */
export interface MetricsRow {
  trace_id: TraceId
  compression_ratio: number
  distill_cost_ratio: number
  key_step_recall: number | null
  replay: number | null
  qa: number | null
  coherence: number | null
  composite: number | null
  rule_coverage: number
  llm_segment_fraction: number
  fail_closed_count: number
}

export function insertMetrics(db: Db, row: MetricsRow): void {
  db.prepare(
    `INSERT INTO metrics (
       trace_id, compression_ratio, distill_cost_ratio,
       key_step_recall, replay, qa, coherence, composite,
       rule_coverage, llm_segment_fraction, fail_closed_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trace_id) DO UPDATE SET
       compression_ratio = excluded.compression_ratio,
       distill_cost_ratio = excluded.distill_cost_ratio,
       key_step_recall = excluded.key_step_recall,
       replay = excluded.replay,
       qa = excluded.qa,
       coherence = excluded.coherence,
       composite = excluded.composite,
       rule_coverage = excluded.rule_coverage,
       llm_segment_fraction = excluded.llm_segment_fraction,
       fail_closed_count = excluded.fail_closed_count`,
  ).run(
    row.trace_id,
    row.compression_ratio,
    row.distill_cost_ratio,
    row.key_step_recall,
    row.replay,
    row.qa,
    row.coherence,
    row.composite,
    row.rule_coverage,
    row.llm_segment_fraction,
    row.fail_closed_count,
  )
}

export function getMetrics(db: Db, trace_id: TraceId): MetricsRow | undefined {
  const row = db.prepare(
    `SELECT trace_id, compression_ratio, distill_cost_ratio,
            key_step_recall, replay, qa, coherence, composite,
            rule_coverage, llm_segment_fraction, fail_closed_count
     FROM metrics WHERE trace_id = ?`,
  ).get(trace_id)
  if (row === undefined) return undefined
  return {
    trace_id: asString(row.trace_id),
    compression_ratio: asNumber(row.compression_ratio),
    distill_cost_ratio: asNumber(row.distill_cost_ratio),
    key_step_recall: nullableNumber(row.key_step_recall),
    replay: nullableNumber(row.replay),
    qa: nullableNumber(row.qa),
    coherence: nullableNumber(row.coherence),
    composite: nullableNumber(row.composite),
    rule_coverage: asNumber(row.rule_coverage),
    llm_segment_fraction: asNumber(row.llm_segment_fraction),
    fail_closed_count: asNumber(row.fail_closed_count),
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.length > 0) return Number(value)
  return null
}
