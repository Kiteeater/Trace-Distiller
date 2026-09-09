import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { FocusLevel } from '../enums/focus.ts'
import { isScenario, type Scenario } from '../enums/scenario.ts'
import type { IntentHypothesis } from '../types/agent_view.ts'
import { AdmissionError, type RawTrace, type TraceId, type TraceSource } from '../types/raw_trace.ts'
import { SEGMENT_OUTCOMES, type SegmentCard, type SegmentOutcome } from '../types/segment.ts'

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
  created_at TEXT NOT NULL,
  intent_text TEXT NOT NULL DEFAULT '',
  intent_version INTEGER NOT NULL DEFAULT 0,
  intent_scenario TEXT
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
  reads_json TEXT NOT NULL DEFAULT '[]',
  writes_json TEXT NOT NULL DEFAULT '[]',
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
  composite REAL,
  rule_coverage REAL,
  llm_segment_fraction REAL,
  fail_closed_count INTEGER
);
`

const SCHEMA_VERSION = 2

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
  migrate(db)
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
  return db
}

function migrate(db: Db): void {
  addColumnIfMissing(db, 'traces', 'intent_text', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing(db, 'traces', 'intent_version', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'traces', 'intent_scenario', 'TEXT')
  addColumnIfMissing(db, 'segments', 'reads_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing(db, 'segments', 'writes_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing(db, 'metrics', 'rule_coverage', 'REAL')
  addColumnIfMissing(db, 'metrics', 'llm_segment_fraction', 'REAL')
  addColumnIfMissing(db, 'metrics', 'fail_closed_count', 'INTEGER')
}

function addColumnIfMissing(db: Db, table: string, column: string, decl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  const names = rows.map((row) => asString(row.name))
  if (names.includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
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

export function upsertIntent(db: Db, trace_id: TraceId, intent: IntentHypothesis): void {
  db.prepare(
    `UPDATE traces SET intent_text = ?, intent_version = ?, intent_scenario = ? WHERE trace_id = ?`,
  ).run(intent.text, intent.version, intent.scenario ?? null, trace_id)
}

export function replaceSegments(db: Db, trace_id: TraceId, cards: SegmentCard[]): void {
  db.prepare('DELETE FROM segments WHERE trace_id = ?').run(trace_id)
  const insert = db.prepare(
    `INSERT INTO segments (
       trace_id, segment_id, tool, sig, outcome, rep_of, tokens, focus, head,
       raw_refs_json, reads_json, writes_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(card.reads),
      JSON.stringify(card.writes),
    )
  }
}

export interface TraceMetaRow {
  trace_id: string
  source: TraceSource
  ground_truth_ref: string
  total_tokens: number
  intent: IntentHypothesis
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
  reads: string[]
  writes: string[]
}

export function listTraceIds(db: Db): string[] {
  const rows = db.prepare(
    `SELECT trace_id FROM traces ORDER BY created_at DESC, trace_id`,
  ).all()
  return rows.map((row) => asString(row.trace_id))
}

export function getTraceMeta(db: Db, trace_id: TraceId): TraceMetaRow | undefined {
  const row = db.prepare(
    `SELECT trace_id, source, ground_truth_ref, total_tokens,
            intent_text, intent_version, intent_scenario
     FROM traces WHERE trace_id = ?`,
  ).get(trace_id)
  if (row === undefined) return undefined
  const scenarioRaw = row.intent_scenario === null || row.intent_scenario === undefined
    ? undefined
    : asString(row.intent_scenario)
  const scenario: Scenario | undefined =
    scenarioRaw !== undefined && isScenario(scenarioRaw) ? scenarioRaw : undefined
  const intent: IntentHypothesis = {
    version: asNumber(row.intent_version),
    text: asString(row.intent_text),
  }
  if (scenario !== undefined) intent.scenario = scenario
  return {
    trace_id: asString(row.trace_id),
    source: asString(row.source) as TraceSource,
    ground_truth_ref: asString(row.ground_truth_ref),
    total_tokens: asNumber(row.total_tokens),
    intent,
  }
}

export function listSegments(db: Db, trace_id: TraceId): SegmentRow[] {
  const rows = db.prepare(
    `SELECT trace_id, segment_id, tool, sig, outcome, rep_of, tokens, focus, head,
            raw_refs_json, reads_json, writes_json
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
    reads: parseStringArray(row.reads_json),
    writes: parseStringArray(row.writes_json),
  }))
}

export function segmentRowToCard(row: SegmentRow): SegmentCard {
  const outcome = SEGMENT_OUTCOMES.includes(row.outcome as SegmentOutcome)
    ? (row.outcome as SegmentOutcome)
    : 'unknown'
  return {
    id: row.segment_id,
    tool: row.tool,
    sig: row.sig,
    outcome,
    rep_of: row.rep_of,
    reads: row.reads,
    writes: row.writes,
    tokens: row.tokens,
    focus: row.focus as FocusLevel,
    head: row.head,
    raw_refs: row.raw_refs,
  }
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
