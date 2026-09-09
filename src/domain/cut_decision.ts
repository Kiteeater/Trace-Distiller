import type { CutAction } from '../enums/cut_action'
import type { Label } from '../enums/label'
import type { CutProfile } from '../types/cut_profile'
import type { WarrantSource } from '../types/cut_warrant'
import type { LabelDecision } from './label_decision'

export interface CutDecision {
  segment_id: string
  action: CutAction
  from_label: Label
  profile_id: string
  source: WarrantSource
  confidence: number
  dead_end_summary?: string
}

export function failClosedKeep(_segment_id: string): CutDecision {
  throw new Error('not implemented')
}

export function decideCut(_label: LabelDecision, _profile: CutProfile): CutDecision {
  throw new Error('not implemented')
}
