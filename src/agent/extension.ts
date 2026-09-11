import {
  EVIDENCE_CARD_KINDS,
  KEEP_EVIDENCE_BITS,
  type EvidenceCardKind,
  type KeepEvidenceBit,
} from '../constant/window.ts'
import { LABELS, type Label } from '../enums/label.ts'
import type { RawTrace } from '../types/raw_trace.ts'
import type { SegmentCard } from '../types/segment.ts'

/**
 * 蒸馏洞 / cut-brain 工具闭集已拍板（ADR-0010 扩展 LOCKED）。
 * 判断力：label_segment / check_continuity / keep_segment。
 * 取数 / hint：read_segment / apply_rules_hint（规则是可选工具，不是独立 --no-llm 路径）。
 * 纯函数 handler：校验枚举 / 取数。不挂 pi、不写 SQLite、不做 keep/drop 落地。
 * rationale 不进凭证。read_segment 只返回本段。Fail-Closed Keep 在编排器（agent/tool failure policy）。
 */
export const HOLE_TOOL_STATUS = 'LOCKED' as const

export const HOLE_JUDGMENT_TOOL_NAMES = [
  'label_segment',
  'check_continuity',
  'keep_segment',
] as const

export const HOLE_FETCH_TOOL_NAMES = ['read_segment', 'apply_rules_hint'] as const

export const HOLE_TOOL_NAMES = [
  'label_segment',
  'check_continuity',
  'keep_segment',
  'read_segment',
  'apply_rules_hint',
] as const

/** cut-brain / 洞 B 共用的全量工具名。 */
export const CUT_BRAIN_TOOL_NAMES = HOLE_TOOL_NAMES

/** 洞 A 稀疏采样仅允许 read_segment（ADR-0011）；禁止 keep/label/drop。 */
export const HOLE_A_TOOL_NAMES = ['read_segment'] as const


export type HoleJudgmentToolName = (typeof HOLE_JUDGMENT_TOOL_NAMES)[number]
export type HoleFetchToolName = (typeof HOLE_FETCH_TOOL_NAMES)[number]
export type HoleToolName = (typeof HOLE_TOOL_NAMES)[number]

export const CONTINUITY_SCORE_MIN = 1
export const CONTINUITY_SCORE_MAX = 5

export type ContinuityScore = 1 | 2 | 3 | 4 | 5

export interface HoleReadContext {
  cards: ReadonlyArray<SegmentCard>
  raw: RawTrace
}

export type HoleToolOk<T> = { ok: true } & T
export type HoleToolErr = { ok: false; error: string }
export type HoleToolResult<T> = HoleToolOk<T> | HoleToolErr

export interface LabelSegmentAccepted {
  segment_id: string
  label: Label
  confidence: number
  keep_bits: KeepEvidenceBit[]
}

export interface ContinuityAccepted {
  left_id: string
  right_id: string
  reachable: boolean
  score: ContinuityScore
  reason: string
}

export interface ReadSegmentAccepted {
  segment_id: string
  focus: 'full'
  text: string
}

export interface KeepSegmentAccepted {
  segment_id: string
  /** Explicit agent keep (ADR-0010); maps to a keep Label for writeWarrant. */
  confidence: number
  keep_bits: KeepEvidenceBit[]
}

export interface ApplyRulesHintAccepted {
  /** Empty args OK; cut-brain runs applyRules when interpreting the call. */
  scope: 'all'
}

export function handleLabelSegment(
  args: unknown,
  windowIds?: ReadonlySet<string>,
): HoleToolResult<LabelSegmentAccepted> {
  const rec = asRecord(args)
  if (rec === undefined) return err('label_segment args must be an object')
  const segment_id = requiredId(rec.segment_id)
  if (segment_id === undefined) return err('label_segment requires segment_id')
  if (windowIds !== undefined && !windowIds.has(segment_id)) {
    return err('label_segment unknown segment_id')
  }
  const label = rec.label
  if (typeof label !== 'string' || !(LABELS as readonly string[]).includes(label)) {
    return err('label_segment label must be one of LABELS')
  }
  const confidence = rec.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return err('label_segment confidence must be a finite number in [0, 1]')
  }
  const bits = parseKeepBits(rec.keep_bits)
  if (!bits.ok) return bits
  return { ok: true, segment_id, label: label as Label, confidence, keep_bits: bits.keep_bits }
}

export function handleCheckContinuity(args: unknown): HoleToolResult<ContinuityAccepted> {
  const rec = asRecord(args)
  if (rec === undefined) return err('check_continuity args must be an object')
  const left_id = requiredId(rec.left_id)
  const right_id = requiredId(rec.right_id)
  if (left_id === undefined || right_id === undefined) {
    return err('check_continuity requires left_id and right_id')
  }
  if (typeof rec.reachable !== 'boolean') {
    return err('check_continuity reachable must be boolean')
  }
  if (!isContinuityScore(rec.score)) {
    return err('check_continuity score must be an integer 1–5')
  }
  if (typeof rec.reason !== 'string' || rec.reason.length === 0) {
    return err('check_continuity reason must be a non-empty string')
  }
  return {
    ok: true,
    left_id,
    right_id,
    reachable: rec.reachable,
    score: rec.score,
    reason: rec.reason,
  }
}

export function handleReadSegment(
  ctx: HoleReadContext,
  args: unknown,
): HoleToolResult<ReadSegmentAccepted> {
  const rec = asRecord(args)
  if (rec === undefined) return err('read_segment args must be an object')
  const segment_id = requiredId(rec.segment_id)
  if (segment_id === undefined) return err('read_segment requires segment_id')
  const card = ctx.cards.find((c) => c.id === segment_id)
  if (card === undefined) return err('read_segment unknown segment_id')
  const turnById = new Map(ctx.raw.turns.map((t) => [t.id, t]))
  const parts: string[] = []
  for (const ref of card.raw_refs) {
    const turn = turnById.get(ref)
    if (turn === undefined) return err('read_segment missing raw turn')
    parts.push(turn.content)
  }
  return { ok: true, segment_id, focus: 'full', text: parts.join('\n') }
}

export function handleKeepSegment(
  args: unknown,
  windowIds?: ReadonlySet<string>,
): HoleToolResult<KeepSegmentAccepted> {
  const rec = asRecord(args)
  if (rec === undefined) return err('keep_segment args must be an object')
  const segment_id = requiredId(rec.segment_id)
  if (segment_id === undefined) return err('keep_segment requires segment_id')
  if (windowIds !== undefined && !windowIds.has(segment_id)) {
    return err('keep_segment unknown segment_id')
  }
  const confidence = rec.confidence
  const conf =
    typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ? confidence
      : 1
  const bits = parseKeepBits(rec.keep_bits)
  if (!bits.ok) return bits
  return { ok: true, segment_id, confidence: conf, keep_bits: bits.keep_bits }
}

/** Args are optional/empty; validates shape only. applyRules runs in cut_brain. */
export function handleApplyRulesHint(args: unknown): HoleToolResult<ApplyRulesHintAccepted> {
  if (args === undefined || args === null) return { ok: true, scope: 'all' }
  const rec = asRecord(args)
  if (rec === undefined) return err('apply_rules_hint args must be an object or empty')
  return { ok: true, scope: 'all' }
}

function err(error: string): HoleToolErr {
  return { ok: false, error }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function requiredId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isContinuityScore(value: unknown): value is ContinuityScore {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CONTINUITY_SCORE_MIN &&
    value <= CONTINUITY_SCORE_MAX
  )
}

function parseKeepBits(value: unknown): HoleToolResult<{ keep_bits: KeepEvidenceBit[] }> {
  if (value === undefined) return { ok: true, keep_bits: [] }
  if (!Array.isArray(value)) return err('keep_bits must be an array')
  const keep_bits: KeepEvidenceBit[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(KEEP_EVIDENCE_BITS as readonly string[]).includes(item)) {
      return err('keep_bits must be skeleton_hit|key_decision_flag')
    }
    if (!keep_bits.includes(item as KeepEvidenceBit)) keep_bits.push(item as KeepEvidenceBit)
  }
  return { ok: true, keep_bits }
}

export function parseEvidenceKind(value: unknown): EvidenceCardKind | undefined {
  if (typeof value !== 'string') return undefined
  if ((EVIDENCE_CARD_KINDS as readonly string[]).includes(value)) return value as EvidenceCardKind
  return undefined
}
