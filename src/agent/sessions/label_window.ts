import type { LabelDecision } from '../../domain/label_decision.ts'
import type { AgentView, IntentHypothesis, Skeleton, SkeletonNode } from '../../types/agent_view.ts'
import type { RawTrace } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'
import {
  NotImplementedError,
  type TokenUsage,
} from './skeleton_pass.ts'

export interface LabelWindowInput {
  segment_ids: string[]
  view: AgentView
  raw: RawTrace
  skeleton: Skeleton
  intent: IntentHypothesis
  skill_path: string
}

export interface SkeletonPatch {
  upsert_nodes: SkeletonNode[]
  remove_node_ids: string[]
}

export interface LabelWindowOutput {
  decisions: LabelDecision[]
  skeleton_patch?: SkeletonPatch
  usage: TokenUsage
}

export interface ContinuityPairResult {
  ok: boolean
  score: number
  reason: string
  usage: TokenUsage
}

/**
 * 洞 B 逐窗打标。待 pi spike；禁止假造 Label / 置信度。
 * TODO createAgentSession — 仅本目录在 spike 后可 import pi。
 * 模型：TRACE_DISTILLER_MODEL_HOLE_B；一窗一会话；失败重试 PI_FAILURE_RETRY 次再 Fail-Closed。
 */
export async function labelWindow(_input: LabelWindowInput): Promise<LabelWindowOutput> {
  throw new NotImplementedError(
    'labelWindow awaits pi spike; do not invent LLM labels or fake tool results',
  )
}

/**
 * 衔接检查复用洞 B 会话，不是新洞。待 pi spike。
 * TODO createAgentSession — 仅本目录在 spike 后可 import pi。
 */
export async function checkContinuityPair(
  _left: SegmentCard,
  _right: SegmentCard,
  _skeleton: Skeleton,
): Promise<ContinuityPairResult> {
  throw new NotImplementedError(
    'checkContinuityPair awaits pi spike; do not invent continuity scores',
  )
}

export { NotImplementedError }
