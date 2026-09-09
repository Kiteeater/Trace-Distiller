import {
  NotImplementedError,
  openQaSession,
  openReviewSession,
} from '../agent/sessions/skeleton_pass.ts'
import { REVIEW_MAX_ROUNDS } from '../constant/window.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { RawTrace } from '../types/raw_trace.ts'

/**
 * 盲测协议（已拍板）：
 * - review 会话输入只有 intent + playback；禁止 warrant / skeleton。
 * - 答卷结构化：turning_point_segment_ids + evidence_segment_ids。
 * - 缺骨架节点由代码回填 keep（`reviewFillInIds`），不是模型点名。
 * - 最多 `REVIEW_MAX_ROUNDS`（2）轮。
 */
export { REVIEW_MAX_ROUNDS }

export interface ReviewInput {
  intent: IntentHypothesis
  playback: PlaybackCut
  /** 仅确定性判分 / 回填用。禁止送进 review 会话。 */
  skeleton: Skeleton
}

export interface ReviewAnswer {
  turning_point_segment_ids: string[]
  evidence_segment_ids: string[]
  free_text?: string
}

export interface ReviewResult {
  passed: boolean
  missing_skeleton_nodes: string[]
  fill_in_segment_ids: string[]
}

export interface QaItem {
  /** OPEN: 题型与生成器未拍板。 */
  id: string
  question: string
}

export interface QaScore {
  /** OPEN: 判分协议未拍板。 */
  answered: number
  correct: number
}

/**
 * 骨架节点在可见段集合中完全看不见时，回填那些段 id 为 keep。
 * 不读 warrant；不把自由文本当分数。
 */
export function reviewFillInIdsForVisible(
  skeleton: Skeleton,
  visibleIds: ReadonlySet<string>,
): string[] {
  const fill: string[] = []
  const seen = new Set<string>()
  for (const node of skeleton.nodes) {
    if (node.segment_ids.length === 0) continue
    if (node.segment_ids.some((id) => visibleIds.has(id))) continue
    for (const id of node.segment_ids) {
      if (seen.has(id)) continue
      seen.add(id)
      fill.push(id)
    }
  }
  return fill
}

function visibleFromPlayback(playback: PlaybackCut): Set<string> {
  return new Set<string>([
    ...playback.cards.map((c) => c.id),
    ...playback.collapsed.map((c) => c.segment_id),
  ])
}

function visibleFromPlan(plan: CutPlan): Set<string> {
  return new Set<string>([...plan.kept, ...plan.collapsed.map((c) => c.segment_id)])
}

function missingSkeletonNodeIds(skeleton: Skeleton, visibleIds: ReadonlySet<string>): string[] {
  return skeleton.nodes
    .filter(
      (node) =>
        node.segment_ids.length > 0 && !node.segment_ids.some((id) => visibleIds.has(id)),
    )
    .map((node) => node.id)
}

/**
 * 骨架节点在 playback（keep 卡片 + collapse 占位）中完全看不见时，回填那些段 id 为 keep。
 */
export function reviewFillInIds(skeleton: Skeleton, playback: PlaybackCut): string[] {
  return reviewFillInIdsForVisible(skeleton, visibleFromPlayback(playback))
}

/**
 * M1 盲测：纯代码对照骨架与 CutPlan，不调 L4 LLM。
 */
export function reviewAgainstPlan(skeleton: Skeleton, plan: CutPlan): ReviewResult {
  const visible = visibleFromPlan(plan)
  const fill_in_segment_ids = reviewFillInIdsForVisible(skeleton, visible)
  return {
    passed: fill_in_segment_ids.length === 0,
    missing_skeleton_nodes: missingSkeletonNodeIds(skeleton, visible),
    fill_in_segment_ids,
  }
}

/**
 * 盲测 review。必须走 sessions 的 openReviewSession，禁止 import pi、禁止注入 warrant。
 */
export async function blindReview(_input: ReviewInput): Promise<ReviewResult> {
  openReviewSession()
  throw new NotImplementedError(
    'blindReview needs agent/sessions openReviewSession (pi spike); do not invent LLM review',
  )
}

/**
 * 从原始 Trace 出 QA 题。空壳：需要真模型 L4，不假装生成题目。
 */
export async function generateQa(_raw: RawTrace, _view: AgentView): Promise<QaItem[]> {
  openQaSession()
  throw new NotImplementedError(
    'generateQa needs real L4 model (TRACE_DISTILLER_MODEL_L4) via openQaSession; do not invent QA items',
  )
}

/**
 * 只根据剪后 Cut 答题。空壳：需要真模型 L4，不假装打分。
 */
export async function answerQa(
  _cut: TrainingCut | PlaybackCut,
  _items: QaItem[],
): Promise<QaScore> {
  openQaSession()
  throw new NotImplementedError(
    'answerQa needs real L4 model (TRACE_DISTILLER_MODEL_L4) via openQaSession; do not invent QA scores',
  )
}
