import type { LabelDecision } from '../domain/label_decision'
import type { TraceId } from '../types/raw_trace'
import type { Db } from './data_segment'

export function insertLabelDecisions(_db: Db, _decisions: LabelDecision[]): void {
  throw new Error('not implemented')
}

export function ruleCoverage(
  _db: Db,
  _trace_id: TraceId,
): {
  total: number
  ruled: number
  llm: number
  fail_closed: number
} {
  throw new Error('not implemented')
}
