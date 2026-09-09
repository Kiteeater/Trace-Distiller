import type { CutAction } from '../enums/cut_action.ts'
import type { CutPlan } from '../types/cut_plan.ts'
import type { CutWarrant, WarrantSourceKind } from '../types/cut_warrant.ts'
import type { TraceId } from '../types/raw_trace.ts'
import { asNumber, asString, type Db } from './data_segment.ts'

export interface WarrantRow {
  trace_id: string
  segment_id: string
  action: CutAction
  source_kind: WarrantSourceKind
  source_name: string
  confidence: number
  dead_end_summary: string | null
}

export interface PlanRow {
  trace_id: string
  profile_id: string
  kept: string[]
  collapsed: CutPlan['collapsed']
  dropped: string[]
  span_ok: boolean
}

export function insertWarrant(db: Db, warrant: CutWarrant): void {
  db.prepare('DELETE FROM warrants WHERE trace_id = ?').run(warrant.trace_id)
  const insert = db.prepare(
    `INSERT INTO warrants (
       trace_id, segment_id, action, source_kind, source_name, confidence, dead_end_summary
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const entry of warrant.entries) {
    insert.run(
      warrant.trace_id,
      entry.segment_id,
      entry.action,
      entry.source.kind,
      entry.source.name,
      entry.confidence,
      entry.dead_end_summary ?? null,
    )
  }
}

export function insertCutPlan(db: Db, plan: CutPlan): void {
  db.prepare(
    `INSERT INTO plans (trace_id, profile_id, kept_json, collapsed_json, dropped_json, span_ok)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(trace_id) DO UPDATE SET
       profile_id = excluded.profile_id,
       kept_json = excluded.kept_json,
       collapsed_json = excluded.collapsed_json,
       dropped_json = excluded.dropped_json,
       span_ok = excluded.span_ok`,
  ).run(
    plan.trace_id,
    plan.profile_id,
    JSON.stringify(plan.kept),
    JSON.stringify(plan.collapsed),
    JSON.stringify(plan.dropped),
    plan.span_ok ? 1 : 0,
  )
}

export function listWarrants(db: Db, trace_id: TraceId): WarrantRow[] {
  const rows = db.prepare(
    `SELECT trace_id, segment_id, action, source_kind, source_name, confidence, dead_end_summary
     FROM warrants WHERE trace_id = ? ORDER BY rowid`,
  ).all(trace_id)
  return rows.map((row) => ({
    trace_id: asString(row.trace_id),
    segment_id: asString(row.segment_id),
    action: asString(row.action) as CutAction,
    source_kind: asString(row.source_kind) as WarrantSourceKind,
    source_name: asString(row.source_name),
    confidence: asNumber(row.confidence),
    dead_end_summary: row.dead_end_summary === null ? null : asString(row.dead_end_summary),
  }))
}

export function getCutPlan(db: Db, trace_id: TraceId): PlanRow | undefined {
  const row = db.prepare(
    `SELECT trace_id, profile_id, kept_json, collapsed_json, dropped_json, span_ok
     FROM plans WHERE trace_id = ?`,
  ).get(trace_id)
  if (row === undefined) return undefined
  return {
    trace_id: asString(row.trace_id),
    profile_id: asString(row.profile_id),
    kept: parseJson(row.kept_json, [] as string[]),
    collapsed: parseJson(row.collapsed_json, [] as CutPlan['collapsed']),
    dropped: parseJson(row.dropped_json, [] as string[]),
    span_ok: asNumber(row.span_ok) === 1,
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
