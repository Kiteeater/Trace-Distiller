import { FAIL_CLOSED_KEEP_RULE } from '../domain/cut_decision.ts'
import type { LabelDecision } from '../domain/label_decision.ts'
import type { Label } from '../enums/label.ts'
import type { WarrantSourceKind } from '../types/cut_warrant.ts'
import type { TraceId } from '../types/raw_trace.ts'
import { asNumber, asString, type Db } from './data_segment.ts'

export interface LabelRow {
  trace_id: string
  segment_id: string
  label: Label
  source_kind: WarrantSourceKind
  source_name: string
  confidence: number
  rule_name: string | null
}

export interface RuleCoverage {
  total: number
  ruled: number
  llm: number
  fail_closed: number
}

export function insertLabelDecisions(
  db: Db,
  trace_id: TraceId,
  decisions: LabelDecision[],
): void {
  const insert = db.prepare(
    `INSERT INTO labels (
       trace_id, segment_id, label, source_kind, source_name, confidence, rule_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trace_id, segment_id) DO UPDATE SET
       label = excluded.label,
       source_kind = excluded.source_kind,
       source_name = excluded.source_name,
       confidence = excluded.confidence,
       rule_name = excluded.rule_name`,
  )
  for (const d of decisions) {
    const ruleName = d.rule_name ?? (d.source.kind === 'rule' ? d.source.name : null)
    insert.run(
      trace_id,
      d.segment_id,
      d.label,
      d.source.kind,
      d.source.name,
      d.confidence,
      ruleName,
    )
  }
}

export function listLabels(db: Db, trace_id: TraceId): LabelRow[] {
  const rows = db.prepare(
    `SELECT trace_id, segment_id, label, source_kind, source_name, confidence, rule_name
     FROM labels WHERE trace_id = ? ORDER BY rowid`,
  ).all(trace_id)
  return rows.map((row) => ({
    trace_id: asString(row.trace_id),
    segment_id: asString(row.segment_id),
    label: asString(row.label) as Label,
    source_kind: asString(row.source_kind) as WarrantSourceKind,
    source_name: asString(row.source_name),
    confidence: asNumber(row.confidence),
    rule_name: row.rule_name === null ? null : asString(row.rule_name),
  }))
}

/** 从 labels.source_kind + warrants.fail_closed 聚合；禁止报告层口头估。 */
export function ruleCoverage(db: Db, trace_id: TraceId): RuleCoverage {
  const total = asNumber(
    db.prepare('SELECT COUNT(*) AS n FROM segments WHERE trace_id = ?').get(trace_id)?.n,
  )
  const ruled = asNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM labels
         WHERE trace_id = ? AND source_kind = 'rule' AND source_name != ?`,
      )
      .get(trace_id, FAIL_CLOSED_KEEP_RULE)?.n,
  )
  const llm = asNumber(
    db
      .prepare(`SELECT COUNT(*) AS n FROM labels WHERE trace_id = ? AND source_kind = 'llm'`)
      .get(trace_id)?.n,
  )
  const failClosedStored = asNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM warrants
         WHERE trace_id = ? AND source_name = ?`,
      )
      .get(trace_id, FAIL_CLOSED_KEEP_RULE)?.n,
  )
  const fail_closed = failClosedStored > 0 ? failClosedStored : Math.max(0, total - ruled - llm)
  return { total, ruled, llm, fail_closed }
}
