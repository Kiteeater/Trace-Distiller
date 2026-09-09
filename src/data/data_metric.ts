import type { TraceId } from '../types/raw_trace.ts'
import { asNumber, asString, type Db } from './data_segment.ts'

/** OPEN schema：评测六项未跑 eval 时为 NULL。 */
export interface MetricsRow {
  trace_id: TraceId
  compression_ratio: number
  distill_cost_ratio: number
  key_step_recall: number | null
  replay: number | null
  qa: number | null
  coherence: number | null
  composite: number | null
}

export function insertMetrics(db: Db, row: MetricsRow): void {
  db.prepare(
    `INSERT INTO metrics (
       trace_id, compression_ratio, distill_cost_ratio,
       key_step_recall, replay, qa, coherence, composite
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trace_id) DO UPDATE SET
       compression_ratio = excluded.compression_ratio,
       distill_cost_ratio = excluded.distill_cost_ratio,
       key_step_recall = excluded.key_step_recall,
       replay = excluded.replay,
       qa = excluded.qa,
       coherence = excluded.coherence,
       composite = excluded.composite`,
  ).run(
    row.trace_id,
    row.compression_ratio,
    row.distill_cost_ratio,
    row.key_step_recall,
    row.replay,
    row.qa,
    row.coherence,
    row.composite,
  )
}

export function getMetrics(db: Db, trace_id: TraceId): MetricsRow | undefined {
  const row = db.prepare(
    `SELECT trace_id, compression_ratio, distill_cost_ratio,
            key_step_recall, replay, qa, coherence, composite
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
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.length > 0) return Number(value)
  return null
}
