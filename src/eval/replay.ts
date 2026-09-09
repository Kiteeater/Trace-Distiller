import { NotImplementedError, openReplaySession } from '../agent/sessions/skeleton_pass.ts'
import type { CutPlan } from '../types/cut_plan.ts'

export interface ReplayTask {
  /** OPEN: 重放环境（docker / 本地无沙箱）未拍板。 */
  trace_id: string
}

/**
 * 按剪后路径重放。必须走 sessions 的 openReplaySession，禁止 import pi。
 * 空壳：需要真模型 L4（`TRACE_DISTILLER_MODEL_L4`）与干净会话，不假装完成重放。
 */
export async function replay(_task: ReplayTask, _plan: CutPlan): Promise<{ success: boolean }> {
  openReplaySession()
  throw new NotImplementedError(
    'replay needs real L4 model (TRACE_DISTILLER_MODEL_L4) via openReplaySession; do not invent replay success',
  )
}
