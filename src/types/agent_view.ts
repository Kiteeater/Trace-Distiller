import type { Scenario } from '../enums/scenario.ts'
import type { TraceMeta } from './raw_trace.ts'
import type { SegmentCard } from './segment.ts'

export interface IntentHypothesis {
  version: number
  text: string
  scenario: Scenario
}

export type SkeletonNodeKind =
  | 'turning_point'
  | 'main_path_hypothesis'
  | 'verification_anchor'

export interface SkeletonNode {
  id: string
  kind: SkeletonNodeKind
  segment_ids: string[]
  note: string
}

export interface Skeleton {
  version: number
  nodes: SkeletonNode[]
}

export interface AgentView {
  meta: TraceMeta
  intent_hypothesis: IntentHypothesis
  skeleton: Skeleton
  segments: SegmentCard[]
}
