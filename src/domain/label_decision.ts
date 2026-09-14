import type { Label } from '../enums/label.ts'
import type { WarrantSource } from '../types/cut_warrant.ts'

export type GraphHint = 'read_then_later_written'

export interface LabelDecision {
  segment_id: string
  label: Label
  source: WarrantSource
  confidence: number
  /** 规则命中名，如 repeat_read；洞 B 可空。 */
  rule_name?: string
  /** 文件依赖图送来的免费信号，不是最终标签。 */
  graph_hints?: GraphHint[]
}

/** 规则已定标的段不再进洞 B；洞 B 不得覆盖。 */
export function isResolvedByRules(d: LabelDecision): boolean {
  return d.source.kind === 'rule'
}

export const RULED_OVERWRITE_REFUSED_MESSAGE =
  'RULED_OVERWRITE_REFUSED: Hole B must not overwrite rule-adopted labels (ADR-0010/0015; isResolvedByRules).'

export interface MergeAdoptedWithBrainResult {
  decisions: LabelDecision[]
  rejected_overwrites: string[]
}

/**
 * Merge L1 adopted labels with Hole B decisions.
 * Rule-resolved ids in `adopted` are never overwritten; conflicts are listed in `rejected_overwrites`.
 */
export function mergeAdoptedWithBrain(
  adopted: readonly LabelDecision[],
  brainDecisions: readonly LabelDecision[],
): MergeAdoptedWithBrainResult {
  const merged = new Map<string, LabelDecision>()
  for (const d of adopted) merged.set(d.segment_id, d)

  const rejected_overwrites: string[] = []
  for (const d of brainDecisions) {
    const existing = merged.get(d.segment_id)
    if (existing !== undefined && isResolvedByRules(existing)) {
      if (!rejected_overwrites.includes(d.segment_id)) rejected_overwrites.push(d.segment_id)
      continue
    }
    merged.set(d.segment_id, d)
  }
  return { decisions: [...merged.values()], rejected_overwrites }
}

/** Always-on: silent Hole B overwrite of ruled ids is a hard invariant failure. */
export function assertNoRuledOverwrite(result: MergeAdoptedWithBrainResult): void {
  if (result.rejected_overwrites.length === 0) return
  throw new Error(
    `${RULED_OVERWRITE_REFUSED_MESSAGE} ids=${result.rejected_overwrites.join(',')}`,
  )
}

export function isRuledOverwriteError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('RULED_OVERWRITE_REFUSED')
}
