import type { AgentRole } from '../../enums/agent_role.ts'
import type { Scenario } from '../../enums/scenario.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../../types/agent_view.ts'
import type { RawTrace, TraceId } from '../../types/raw_trace.ts'

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

export interface TokenUsage {
  role: AgentRole
  input_tokens: number
  output_tokens: number
}

export interface SessionFactoryOpts {
  role: AgentRole
  model?: string
}

/** 句柄占位。pi spike 之前不得假装已有会话。 */
export interface PiSessionHandle {
  readonly role: AgentRole
}

export interface SkeletonPassInput {
  trace_id: TraceId
  /** adapter 标出的锚点；sessions 按 id 从 RawTrace 取原文，不得擅自改读全量 */
  head_turn_ids: string[]
  verification_turn_ids: string[]
  raw: RawTrace
  view: AgentView
}

export interface SkeletonPassOutput {
  intent: IntentHypothesis
  scenario: Scenario
  skeleton: Skeleton
  usage: TokenUsage
}

/**
 * 洞 A。待 pi spike；禁止假造 LLM 意图 / 骨架。
 * TODO createAgentSession — 仅本目录在 spike 后可 import pi。
 * 模型：TRACE_DISTILLER_MODEL_HOLE_A；失败重试 PI_FAILURE_RETRY 次再 Fail-Closed。
 */
export async function skeletonPass(_input: SkeletonPassInput): Promise<SkeletonPassOutput> {
  throw new NotImplementedError(
    'skeletonPass awaits pi spike; do not invent LLM intent/skeleton results',
  )
}

/**
 * L4 与两洞共用的会话工厂。不算第三洞。eval 必须走这里，禁止自己 createAgentSession。
 * TODO createAgentSession — 仅本目录在 spike 后可 import pi。
 * 模型：TRACE_DISTILLER_MODEL_HOLE_A / _HOLE_B / _L4；失败重试 PI_FAILURE_RETRY 次再 Fail-Closed。
 */
export function openSession(_opts: SessionFactoryOpts): PiSessionHandle {
  throw new NotImplementedError(
    'openSession awaits pi spike; do not invent an LLM session or fake results',
  )
}

export function openReviewSession(): PiSessionHandle {
  return openSession({ role: 'l4_review' })
}

export function openReplaySession(): PiSessionHandle {
  return openSession({ role: 'l4_replay' })
}

export function openQaSession(): PiSessionHandle {
  return openSession({ role: 'l4_qa' })
}
