import type { CutAction } from '../enums/cut_action.ts'
import type { TraceId } from './raw_trace.ts'

export const WARRANT_SOURCE_KINDS = ['rule', 'llm'] as const

export type WarrantSourceKind = (typeof WARRANT_SOURCE_KINDS)[number]

export interface WarrantSource {
  kind: WarrantSourceKind
  /** 规则名，或洞 B skill 名。 */
  name: string
}

export interface CutWarrantEntry {
  segment_id: string
  action: CutAction
  source: WarrantSource
  confidence: number
  /** 仅 action === 'collapse' 时出现。 */
  dead_end_summary?: string
}

export interface CutWarrant {
  trace_id: TraceId
  /** 必须覆盖 AgentView.segments 的每一个 id。 */
  entries: CutWarrantEntry[]
}
