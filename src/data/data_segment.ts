import type { SegmentCard } from '../types/segment'
import type { RawTrace, TraceId } from '../types/raw_trace'
import type { LabelDecision } from '../domain/label_decision'

export type Db = { readonly brand: 'Db' }

export function openDb(_sqlitePath: string): Db {
  throw new Error('not implemented')
}

export function upsertTraceMeta(_db: Db, _raw: RawTrace): void {
  throw new Error('not implemented')
}

export function replaceSegments(_db: Db, _trace_id: TraceId, _cards: SegmentCard[]): void {
  throw new Error('not implemented')
}

export function loadSegmentQueue(
  _db: Db,
  _trace_id: TraceId,
): {
  resolved: LabelDecision[]
  unresolved_ids: string[]
} {
  throw new Error('not implemented')
}
