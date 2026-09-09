import type { Label } from '../enums/label'
import type { Skeleton, SkeletonPatch } from '../types/agent_view'
import type { WarrantSource } from '../types/cut_warrant'

export type GraphHint = 'read_then_later_written'

export interface LabelDecision {
  segment_id: string
  label: Label
  source: WarrantSource
  confidence: number
  rule_name?: string
  graph_hints?: GraphHint[]
}

export function isResolvedByRules(_d: LabelDecision): boolean {
  throw new Error('not implemented')
}

export function mergeSkeleton(_base: Skeleton, _patches: SkeletonPatch[]): Skeleton {
  throw new Error('not implemented')
}
