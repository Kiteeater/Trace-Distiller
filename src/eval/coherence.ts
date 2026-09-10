import { checkContinuityPair } from '../agent/sessions/label_window.ts'
import { holeModelsConfigured, hasInjectedSessionBackend } from '../agent/sessions/open_session.ts'
import type { Skeleton } from '../types/agent_view.ts'
import type { SegmentCard } from '../types/segment.ts'

/**
 * 对剪后 keep 路径相邻段跑洞 B check_continuity，收集 1–5 分。
 * 无洞模型 / 无注入后端时返回 null（skipped），不瞎编分。
 */
export async function scoreKeptPathCoherence(input: {
  kept_ids: readonly string[]
  cards: readonly SegmentCard[]
  skeleton: Skeleton
}): Promise<number[] | null> {
  if (!holeModelsConfigured() && !hasInjectedSessionBackend()) return null
  if (input.kept_ids.length < 2) return null

  const byId = new Map(input.cards.map((c) => [c.id, c]))
  const scores: number[] = []
  for (let i = 0; i < input.kept_ids.length - 1; i++) {
    const leftId = input.kept_ids[i]!
    const rightId = input.kept_ids[i + 1]!
    const left = byId.get(leftId)
    const right = byId.get(rightId)
    if (left === undefined || right === undefined) continue
    try {
      const out = await checkContinuityPair(left, right, input.skeleton)
      scores.push(out.score)
    } catch {
      // 单对失败不编分；整条连贯性视为未跑完 → 调用方见空数组当 skipped
      return null
    }
  }
  return scores.length > 0 ? scores : null
}
