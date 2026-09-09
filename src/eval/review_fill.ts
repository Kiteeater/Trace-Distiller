import type { Skeleton } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut } from '../types/cut_plan.ts'

/**
 * 纯代码盲测对照。编排器只依赖本文件，不 import L4 会话。
 */
export interface ReviewFillResult {
  passed: boolean
  missing_skeleton_nodes: string[]
  fill_in_segment_ids: string[]
}

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

export function visibleFromPlayback(playback: PlaybackCut): Set<string> {
  return new Set<string>([
    ...playback.cards.map((c) => c.id),
    ...playback.collapsed.map((c) => c.segment_id),
  ])
}

export function visibleFromPlan(plan: CutPlan): Set<string> {
  return new Set<string>([...plan.kept, ...plan.collapsed.map((c) => c.segment_id)])
}

export function missingSkeletonNodeIds(
  skeleton: Skeleton,
  visibleIds: ReadonlySet<string>,
): string[] {
  return skeleton.nodes
    .filter(
      (node) =>
        node.segment_ids.length > 0 && !node.segment_ids.some((id) => visibleIds.has(id)),
    )
    .map((node) => node.id)
}

export function reviewFillInIds(skeleton: Skeleton, playback: PlaybackCut): string[] {
  return reviewFillInIdsForVisible(skeleton, visibleFromPlayback(playback))
}

export function reviewAgainstPlan(skeleton: Skeleton, plan: CutPlan): ReviewFillResult {
  const visible = visibleFromPlan(plan)
  const fill_in_segment_ids = reviewFillInIdsForVisible(skeleton, visible)
  return {
    passed: fill_in_segment_ids.length === 0,
    missing_skeleton_nodes: missingSkeletonNodeIds(skeleton, visible),
    fill_in_segment_ids,
  }
}
