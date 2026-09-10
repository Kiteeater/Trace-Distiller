import type { CutAction } from '../enums/cut_action.ts'
import type { Label } from '../enums/label.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import type { WarrantSource } from '../types/cut_warrant.ts'
import type { SegmentCard } from '../types/segment.ts'
import type { LabelDecision } from './label_decision.ts'

export const FAIL_CLOSED_KEEP_RULE = 'fail_closed_keep'

export interface CutDecision {
  segment_id: string
  action: CutAction
  /** 未决 / Fail-Closed 没有标签，不写此字段。 */
  from_label?: Label
  profile_id: string
  source: WarrantSource
  confidence: number
  dead_end_summary?: string
}

/**
 * Label + CutProfile → 裁剪动作。keep 名单优先（宁多勿漏）。
 * 未出现在三份名单里的标签同样 keep。
 * collapse 时用卡片 head 截断填 dead_end_summary。
 */
export function decideCut(
  labeled: LabelDecision,
  profile: CutProfile,
  card?: SegmentCard,
): CutDecision {
  const action = actionForLabel(labeled.label, profile)
  const decision: CutDecision = {
    segment_id: labeled.segment_id,
    action,
    from_label: labeled.label,
    profile_id: profile.id,
    source: labeled.source,
    confidence: labeled.confidence,
  }
  if (action === 'collapse') {
    decision.dead_end_summary = deadEndSummary(card, profile.dead_end.summary_max_chars)
  }
  return decision
}

/** 窗失败 / --no-llm 未决：一律 keep，source 可查。永不 drop/collapse。 */
export function failClosedKeep(segment_id: string, profile_id: string): CutDecision {
  return {
    segment_id,
    action: 'keep',
    profile_id,
    source: { kind: 'rule', name: FAIL_CLOSED_KEEP_RULE },
    confidence: 1,
  }
}

function actionForLabel(label: Label, profile: CutProfile): CutAction {
  if (profile.keep_labels.includes(label)) return 'keep'
  if (profile.collapse_labels.includes(label)) return 'collapse'
  if (profile.drop_labels.includes(label)) return 'drop'
  return 'keep'
}

/**
 * Collapse 摘要：优先 `tool outcome`（短、稳定），否则用 head。
 * 空内容给占位，避免 assembler 拒 collapse。截到 `summary_max_chars`。
 * 短摘要让 short 档（add-fix）能过压缩门；长 Trace 仍靠 drop 吃掉体积。
 */
export function deadEndSummary(
  cardOrHead: SegmentCard | string | undefined,
  maxChars: number,
): string {
  const text = summarizeDeadEnd(cardOrHead)
  if (typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 0) {
    const sliced = text.slice(0, maxChars)
    return sliced.length > 0 ? sliced : text
  }
  return text
}

function summarizeDeadEnd(cardOrHead: SegmentCard | string | undefined): string {
  if (cardOrHead === undefined) return 'dead_end'
  if (typeof cardOrHead === 'string') {
    return cardOrHead.length > 0 ? cardOrHead : 'dead_end'
  }
  const tool = cardOrHead.tool.trim()
  const outcome = cardOrHead.outcome.trim()
  if (tool.length > 0) {
    const compact = outcome.length > 0 ? `${tool} ${outcome}` : tool
    if (compact.trim().length > 0) return compact
  }
  return cardOrHead.head.length > 0 ? cardOrHead.head : 'dead_end'
}
