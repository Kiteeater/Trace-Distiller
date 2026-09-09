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
