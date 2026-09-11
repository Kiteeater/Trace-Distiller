import {
  runQa,
  type QaItem,
  type QaScore,
  type SessionBackend,
} from '../agent/sessions/l4_qa.ts'
import {
  runBlindReview as runBlindReviewSession,
  type ReviewAnswer,
} from '../agent/sessions/l4_review.ts'
import { REVIEW_MAX_ROUNDS } from '../constant/window.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../types/agent_view.ts'
import type { PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { RawTrace } from '../types/raw_trace.ts'
import {
  missingSkeletonNodeIds,
  reviewAgainstPlan,
  reviewFillInIds,
  reviewFillInIdsForVisible,
  visibleFromPlayback,
} from './review_fill.ts'

export { REVIEW_MAX_ROUNDS }
export type { QaItem, QaScore, ReviewAnswer }
export {
  reviewAgainstPlan,
  reviewFillInIds,
  reviewFillInIdsForVisible,
}

/**
 * 盲测协议（已拍板）：
 * - review 会话输入只有 intent + playback；禁止 warrant / skeleton。
 * - 答卷结构化：turning_point_segment_ids + evidence_segment_ids。
 * - 缺 **关键**骨架节点（turning_point / verification_anchor）由代码回填 keep（每节点一段）；不复活 main_path / 例行死胡同。
 * - 最多 `REVIEW_MAX_ROUNDS`（2）轮。
 * - 编排器只调 `reviewAgainstPlan`（纯代码），不 import L4 会话。
 */
export interface ReviewInput {
  intent: IntentHypothesis
  playback: PlaybackCut
  /** 仅确定性判分 / 回填用。禁止送进 review 会话。 */
  skeleton: Skeleton
  backend?: SessionBackend
}

export interface ReviewResult {
  passed: boolean
  missing_skeleton_nodes: string[]
  fill_in_segment_ids: string[]
  answer?: ReviewAnswer
}

/**
 * 盲测 review。会话只经 runBlindReview（intent + playback）。
 * 骨架仅用于代码对照回填，不进会话。
 */
export async function blindReview(input: ReviewInput): Promise<ReviewResult> {
  const session = await runBlindReviewSession({
    intent: input.intent,
    playback: input.playback,
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
  })
  const visible = visibleFromPlayback(input.playback)
  const fill_in_segment_ids = reviewFillInIdsForVisible(input.skeleton, visible)
  return {
    passed: fill_in_segment_ids.length === 0,
    missing_skeleton_nodes: missingSkeletonNodeIds(input.skeleton, visible),
    fill_in_segment_ids,
    answer: session.answer,
  }
}

/**
 * 从原始 Trace / AgentView 出 QA 题。走 L4 QA 会话；无题时由模型（或假后端）生成。
 */
export async function generateQa(
  _raw: RawTrace,
  view: AgentView,
  opts?: { playback?: PlaybackCut; backend?: SessionBackend },
): Promise<QaItem[]> {
  const playback =
    opts?.playback ??
    ({
      trace_id: view.meta.trace_id,
      plan_ref: 'view',
      cards: view.segments,
      collapsed: [],
    } satisfies PlaybackCut)
  const out = await runQa({
    intent: view.intent_hypothesis,
    playback,
    ...(opts?.backend !== undefined ? { backend: opts.backend } : {}),
  })
  return out.items.map((item) => ({ id: item.id, question: item.question }))
}

/**
 * 只根据剪后 Cut 答题。走 L4 QA 会话。
 */
export async function answerQa(
  cut: TrainingCut | PlaybackCut,
  items: QaItem[],
  opts?: { intent?: IntentHypothesis; backend?: SessionBackend },
): Promise<QaScore> {
  const intent = opts?.intent ?? { version: 0, text: '' }
  const playback = isPlayback(cut)
    ? cut
    : {
        trace_id: cut.trace_id,
        plan_ref: cut.plan_ref,
        cards: [],
        collapsed: [],
      }
  const training = isPlayback(cut) ? undefined : cut
  const out = await runQa({
    intent,
    playback,
    questions: items,
    ...(training !== undefined ? { training } : {}),
    ...(opts?.backend !== undefined ? { backend: opts.backend } : {}),
  })
  return out.score
}

function isPlayback(cut: TrainingCut | PlaybackCut): cut is PlaybackCut {
  return 'cards' in cut
}
