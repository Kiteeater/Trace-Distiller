import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { AdmissionError, type RawTrace, type TraceId } from '../types/raw_trace.ts'
import type { SegmentCard } from '../types/segment.ts'

/** node:sqlite 连接。pipeline / agent 不得持有此类型。 */
export type Db = DatabaseSync

/**
 * OPEN schema：列级未拍板（docs/modules/data.md §6、TODO P0）。
 * 按草图落最小可用表；不是正式契约。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  ground_truth_ref TEXT NOT NULL,
  total_tokens INTEGER NOT NULL,
  raw_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  trace_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  sig TEXT NOT NULL,
  outcome TEXT NOT NULL,
  rep_of TEXT,
  tokens INTEGER NOT NULL,
  focus TEXT NOT NULL,
  head TEXT NOT NULL,
  raw_refs_json TEXT NOT NULL,
  PRIMARY KEY (trace_id, segment_id)
);

CREATE TABLE IF NOT EXISTS labels (
  trace_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  label TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  confidence REAL NOT NULL,
  rule_name TEXT,
  PRIMARY KEY (trace_id, segment_id)
);

CREATE TABLE IF NOT EXISTS warrants (
  trace_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  action TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  confidence REAL NOT NULL,
  dead_end_summary TEXT,
  PRIMARY KEY (trace_id, segment_id)
);

CREATE TABLE IF NOT EXISTS plans (
  trace_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  kept_json TEXT NOT NULL,
  collapsed_json TEXT NOT NULL,
  dropped_json TEXT NOT NULL,
  span_ok INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  trace_id TEXT PRIMARY KEY,
  compression_ratio REAL NOT NULL,
  distill_cost_ratio REAL NOT NULL,
  key_step_recall REAL,
  replay REAL,
  qa REAL,
  coherence REAL,
  composite REAL
);
`

const SCHEMA_VERSION = 1

/** 打开/迁移。路径由 service 传入；`:memory:` 不建目录。 */
export function openDb(sqlitePath: string): Db {
  if (sqlitePath !== ':memory:') {
    const dir = dirname(sqlitePath)
    if (dir.length > 0 && dir !== '.') {
      mkdirSync(dir, { recursive: true })
    }
  }
  const db = new DatabaseSync(sqlitePath)
  db.exec(SCHEMA_SQL)
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
  return db
}

export function runInTransaction(db: Db, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function upsertTraceMeta(db: Db, raw: RawTrace): void {
  const ref = raw.meta.ground_truth_ref.trim()
  if (ref.length === 0) {
    throw new AdmissionError('no_ground_truth', '无 Ground Truth，拒绝入库')
  }
  db.prepare(
    `INSERT INTO traces (trace_id, source, ground_truth_ref, total_tokens, raw_path, created_at)
     VALUES (?, ?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(trace_id) DO UPDATE SET
       source = excluded.source,
       ground_truth_ref = excluded.ground_truth_ref,
       total_tokens = excluded.total_tokens`,
  ).run(raw.meta.trace_id, raw.meta.source, ref, raw.meta.total_tokens)
}

export function replaceSegments(db: Db, trace_id: TraceId, cards: SegmentCard[]): void {
  db.prepare('DELETE FROM segments WHERE trace_id = ?').run(trace_id)
  const insert = db.prepare(
    `INSERT INTO segments (
       trace_id, segment_id, tool, sig, outcome, rep_of, tokens, focus, head, raw_refs_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const card of cards) {
    insert.run(
      trace_id,
      card.id,
      card.tool,
      card.sig,
      card.outcome,
      card.rep_of,
      card.tokens,
      card.focus,
      card.head,
      JSON.stringify(card.raw_refs),
    )
  }
}

export interface TraceMetaRow {
  trace_id: string
  source: string
  ground_truth_ref: string
  total_tokens: number
}

export interface SegmentRow {
  trace_id: string
  segment_id: string
  tool: string
  sig: string
  outcome: string
  rep_of: string | null
  tokens: number
  focus: string
  head: string
  raw_refs: string[]
}

export function getTraceMeta(db: Db, trace_id: TraceId): TraceMetaRow | undefined {
  const row = db.prepare(
    'SELECT trace_id, source, ground_truth_ref, total_tokens FROM traces WHERE trace_id = ?',
  ).get(trace_id)
  if (row === undefined) return undefined
  return {
    trace_id: asString(row.trace_id),
    source: asString(row.source),
    ground_truth_ref: asString(row.ground_truth_ref),
    total_tokens: asNumber(row.total_tokens),
  }
}

export function listSegments(db: Db, trace_id: TraceId): SegmentRow[] {
  const rows = db.prepare(
    `SELECT trace_id, segment_id, tool, sig, outcome, rep_of, tokens, focus, head, raw_refs_json
     FROM segments WHERE trace_id = ? ORDER BY rowid`,
  ).all(trace_id)
  return rows.map((row) => ({
    trace_id: asString(row.trace_id),
    segment_id: asString(row.segment_id),
    tool: asString(row.tool),
    sig: asString(row.sig),
    outcome: asString(row.outcome),
    rep_of: row.rep_of === null ? null : asString(row.rep_of),
    tokens: asNumber(row.tokens),
    focus: asString(row.focus),
    head: asString(row.head),
    raw_refs: parseStringArray(row.raw_refs_json),
  }))
}

export function asString(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

export function asNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value)
  return 0
}

function parseStringArray(value: SQLOutputValue | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === 'string')
}
