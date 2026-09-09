import type { CutAction } from '../enums/cut_action.ts'
import type { Label } from '../enums/label.ts'
import type { WarrantSource } from '../types/cut_warrant.ts'

export interface CutDecision {
  segment_id: string
  action: CutAction
  from_label: Label
  profile_id: string
  source: WarrantSource
  confidence: number
  dead_end_summary?: string
}
