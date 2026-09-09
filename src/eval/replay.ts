import {
  runReplay,
  type L4ReplayTask,
  type SessionBackend,
} from '../agent/sessions/l4_replay.ts'
import type { CutPlan, PlaybackCut } from '../types/cut_plan.ts'

export type ReplayTask = L4ReplayTask

/**
 * 按剪后路径重放。必须走 sessions 的 runReplay / openReplaySession，禁止 import pi。
 * 干净会话：不代理原 agent 工具历史。
 * 真实成功率需要仓库 + 模型；接口由假后端 / 可解析 JSON 保证。
 */
export async function replay(
  task: ReplayTask,
  plan: CutPlan,
  opts?: { playback?: PlaybackCut; cwd?: string; backend?: SessionBackend },
): Promise<{ success: boolean; note?: string }> {
  const playback =
    opts?.playback ??
    ({
      trace_id: task.trace_id,
      plan_ref: plan.warrant_ref,
      cards: [],
      collapsed: plan.collapsed,
    } satisfies PlaybackCut)
  const out = await runReplay({
    task,
    playback,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.backend !== undefined ? { backend: opts.backend } : {}),
  })
  return out.note !== undefined ? { success: out.success, note: out.note } : { success: out.success }
}
