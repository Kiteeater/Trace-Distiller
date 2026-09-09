import type { AgentRole } from '../enums/agent_role'
import type { TraceId } from '../types/raw_trace'
import type { Db } from './data_segment'

export interface MetricsRow {
  trace_id: TraceId
  compression_ratio: number
  distill_cost_ratio: number
  key_step_recall: number
  replay: number
  qa: number
  coherence: number
  composite: number
}

export function insertUsage(
  _db: Db,
  _row: {
    trace_id: TraceId
    role: AgentRole
    input_tokens: number
    output_tokens: number
  },
): void {
  throw new Error('not implemented')
}

export function insertMetrics(_db: Db, _row: MetricsRow): void {
  throw new Error('not implemented')
}
