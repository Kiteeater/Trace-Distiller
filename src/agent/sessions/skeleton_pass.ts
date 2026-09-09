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

export type {
  PiSessionHandle,
  SessionFactoryOpts,
} from './open_session.ts'

export {
  openQaSession,
  openReplaySession,
  openReviewSession,
  openSession,
} from './open_session.ts'

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
 * 洞 A。工厂已接通；本函数仍待完整打标，禁止假造 LLM 意图 / 骨架。
 * 会话只经 open_session.ts 的 createAgentSession。
 * 模型：TRACE_DISTILLER_MODEL_HOLE_A；失败重试 PI_FAILURE_RETRY 次再 Fail-Closed。
 */
export async function skeletonPass(_input: SkeletonPassInput): Promise<SkeletonPassOutput> {
  throw new NotImplementedError(
    'skeletonPass awaits pi spike; do not invent LLM intent/skeleton results',
  )
}
