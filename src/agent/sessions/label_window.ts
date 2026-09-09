import type { LabelDecision } from '../../domain/label_decision'
import type {
  AgentView,
  IntentHypothesis,
  Skeleton,
  SkeletonPatch,
} from '../../types/agent_view'
import type { SegmentCard } from '../../types/segment'
import type { RawTrace } from '../../types/raw_trace'
import type { TokenUsage } from './skeleton_pass'

export interface LabelWindowInput {
  segment_ids: string[]
  view: AgentView
  raw: RawTrace
  skeleton: Skeleton
  intent: IntentHypothesis
  skill_path: string
}

export interface LabelWindowOutput {
  decisions: LabelDecision[]
  skeleton_patch?: SkeletonPatch
  usage: TokenUsage
}

export function labelWindow(_input: LabelWindowInput): Promise<LabelWindowOutput> {
  throw new Error('not implemented')
}

export function checkContinuityPair(
  _left: SegmentCard,
  _right: SegmentCard,
  _skeleton: Skeleton,
): Promise<{ ok: boolean; score: number; reason: string; usage: TokenUsage }> {
  throw new Error('not implemented')
}
