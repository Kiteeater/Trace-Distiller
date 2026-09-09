import { NotImplementedError, openReplaySession } from '../agent/sessions/skeleton_pass.ts'
import type { CutPlan } from '../types/cut_plan.ts'

export interface ReplayTask {
  /** OPEN: 重放环境（docker / 本地无沙箱）未拍板。 */
  trace_id: string
}

/**
 * 按剪后路径重放。必须走 sessions 的 openReplaySession，禁止 import pi。
 */
export async function replay(_task: ReplayTask, _plan: CutPlan): Promise<{ success: boolean }> {
  openReplaySession()
  throw new NotImplementedError(
    'replay needs agent/sessions openReplaySession (pi spike); do not invent replay success',
  )
}
