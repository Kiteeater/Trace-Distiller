import { checkContinuityPair } from '../agent/sessions/label_window.ts'
import { holeModelsConfigured, hasInjectedSessionBackend } from '../agent/sessions/open_session.ts'
import type { Skeleton } from '../types/agent_view.ts'
import type { SegmentCard } from '../types/segment.ts'

export interface CoherenceScoreResult {
  /** null = skipped / incomplete（不瞎编分） */
  scores: number[] | null
  notes: string[]
}

/**
 * 对剪后 keep 路径相邻段跑洞 B check_continuity，收集 1–5 分。
 * 无洞模型 / 无注入后端时返回 scores=null（skipped），不瞎编分。
 * 单对失败记 note 并整条 skipped（不半截填分）。
 */
export async function scoreKeptPathCoherence(input: {
  kept_ids: readonly string[]
  cards: readonly SegmentCard[]
  skeleton: Skeleton
}): Promise<CoherenceScoreResult> {
  const notes: string[] = []
  if (!holeModelsConfigured() && !hasInjectedSessionBackend()) {
    notes.push('coherence skipped: no hole B model / injected backend')
    return { scores: null, notes }
  }
  if (input.kept_ids.length < 2) {
    notes.push('coherence skipped: kept path shorter than 2')
    return { scores: null, notes }
  }

  const byId = new Map(input.cards.map((c) => [c.id, c]))
  const scores: number[] = []
  for (let i = 0; i < input.kept_ids.length - 1; i++) {
    const leftId = input.kept_ids[i]!
    const rightId = input.kept_ids[i + 1]!
    const left = byId.get(leftId)
    const right = byId.get(rightId)
    if (left === undefined || right === undefined) {
      notes.push(`coherence failed: missing card for pair ${leftId}->${rightId}`)
      return { scores: null, notes }
    }
    try {
      const out = await checkContinuityPair(left, right, input.skeleton)
      scores.push(out.score)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      notes.push(`coherence failed at ${leftId}->${rightId}: ${message}`)
      return { scores: null, notes }
    }
  }
  if (scores.length === 0) {
    notes.push('coherence skipped: no pairs scored')
    return { scores: null, notes }
  }
  return { scores, notes }
}
