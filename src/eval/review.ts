import {
  NotImplementedError,
  openQaSession,
  openReviewSession,
} from '../agent/sessions/skeleton_pass.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../types/agent_view.ts'
import type { PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { RawTrace } from '../types/raw_trace.ts'

export interface ReviewInput {
  intent: IntentHypothesis
  playback: PlaybackCut
  /** 仅确定性判分用。禁止送进 review 会话。 */
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
 * 盲测 review。必须走 sessions 的 openReviewSession，禁止 import pi、禁止注入 warrant。
 */
export async function blindReview(_input: ReviewInput): Promise<ReviewResult> {
  openReviewSession()
  throw new NotImplementedError(
    'blindReview needs agent/sessions openReviewSession (pi spike); do not invent LLM review',
  )
}

export async function generateQa(_raw: RawTrace, _view: AgentView): Promise<QaItem[]> {
  openQaSession()
  throw new NotImplementedError(
    'generateQa needs agent/sessions openQaSession (pi spike); do not invent QA items',
  )
}

export async function answerQa(
  _cut: TrainingCut | PlaybackCut,
  _items: QaItem[],
): Promise<QaScore> {
  openQaSession()
  throw new NotImplementedError(
    'answerQa needs agent/sessions openQaSession (pi spike); do not invent QA scores',
  )
}
