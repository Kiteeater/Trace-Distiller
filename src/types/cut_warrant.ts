import type { CutAction } from '../enums/cut_action'
import type { TraceId } from './raw_trace'

export type WarrantSourceKind = 'rule' | 'llm'

export interface WarrantSource {
  kind: WarrantSourceKind
  name: string
}

export interface CutWarrantEntry {
  segment_id: string
  action: CutAction
  source: WarrantSource
  confidence: number
  dead_end_summary?: string
}

export interface CutWarrant {
  trace_id: TraceId
  entries: CutWarrantEntry[]
}
