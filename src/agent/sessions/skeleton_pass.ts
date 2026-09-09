import type { AgentRole } from '../../enums/agent_role'
import type { AgentView, IntentHypothesis, Skeleton } from '../../types/agent_view'
import type { RawTrace, TraceId } from '../../types/raw_trace'

export type PiSessionHandle = { readonly brand: 'PiSessionHandle' }

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

export interface SessionFactoryOpts {
  role: AgentRole
  model?: string
}

export interface SkeletonPassInput {
  trace_id: TraceId
  head_turn_ids: string[]
  verification_turn_ids: string[]
  raw: RawTrace
  view: AgentView
}

export interface SkeletonPassOutput {
  intent: IntentHypothesis
  scenario: string
  skeleton: Skeleton
  usage: TokenUsage
}

export function openSession(_opts: SessionFactoryOpts): PiSessionHandle {
  throw new Error('not implemented')
}

export function openReviewSession(): PiSessionHandle {
  throw new Error('not implemented')
}

export function openReplaySession(): PiSessionHandle {
  throw new Error('not implemented')
}

export function openQaSession(): PiSessionHandle {
  throw new Error('not implemented')
}

export function skeletonPass(_input: SkeletonPassInput): Promise<SkeletonPassOutput> {
  throw new Error('not implemented')
}
