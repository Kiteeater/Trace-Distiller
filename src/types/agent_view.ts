import type { Scenario } from '../enums/scenario'
import type { TraceMeta } from './raw_trace'
import type { SegmentCard } from './segment'

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

export interface SkeletonPatch {
  upsert_nodes: SkeletonNode[]
  remove_node_ids: string[]
}

export interface AgentView {
  meta: TraceMeta
  intent_hypothesis: IntentHypothesis
  skeleton: Skeleton
  segments: SegmentCard[]
}
