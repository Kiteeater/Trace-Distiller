import type { CutPlan } from '../types/cut_plan.ts'

export const SPAN_VIOLATION_REASONS = ['gap_too_large', 'continuity_fail'] as const

export type SpanViolationReason = (typeof SPAN_VIOLATION_REASONS)[number]

export interface SpanViolation {
  id: string
  left_segment_id: string
  right_segment_id: string
  gap_segments: number
  reason: SpanViolationReason
  /** 洞 B check_continuity 的分数，若请过。 */
  continuity_score?: number
}

/**
 * 剪后序列不够得着：assembler 不偷偷返回 span_ok: true。
 * 回退（加回缺口内的段 / 插入代表性死胡同）由 orchestrator 选。
 */
export class SpanFailure extends Error {
  readonly plan: CutPlan
  readonly violations: SpanViolation[]

  constructor(plan: CutPlan, violations: SpanViolation[]) {
    super(`span constraint unsatisfied (${String(violations.length)} violation(s))`)
    this.name = 'SpanFailure'
    this.plan = plan
    this.violations = violations
  }
}

export function isSpanFailure(error: unknown): error is SpanFailure {
  return error instanceof SpanFailure
}
