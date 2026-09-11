import type { Skeleton, SkeletonNodeKind } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut } from '../types/cut_plan.ts'

/**
 * 纯代码盲测对照。编排器只依赖本文件，不 import L4 会话。
 *
 * 回填只补 **关键骨架**（turning_point / verification_anchor）缺口：
 * 不把 main_path_hypothesis 整段复活成 keep，避免例行/死胡同被盲测抬回导致压缩率爆掉。
 * 每个缺失关键节点只回填 **一个** 代表段（segment_ids[0]）。
 */
export interface ReviewFillResult {
  passed: boolean
  missing_skeleton_nodes: string[]
  fill_in_segment_ids: string[]
}

/** 盲测回填认的关键骨架种类（与 skeletonWeakGoldIds 对齐）。 */
export const KEY_SKELETON_KINDS: ReadonlySet<SkeletonNodeKind> = new Set([
  'turning_point',
  'verification_anchor',
])

function isKeySkeletonNode(kind: SkeletonNodeKind): boolean {
  return KEY_SKELETON_KINDS.has(kind)
}

export function reviewFillInIdsForVisible(
  skeleton: Skeleton,
  visibleIds: ReadonlySet<string>,
): string[] {
  const fill: string[] = []
  const seen = new Set<string>()
  for (const node of skeleton.nodes) {
    if (!isKeySkeletonNode(node.kind)) continue
    if (node.segment_ids.length === 0) continue
    if (node.segment_ids.some((id) => visibleIds.has(id))) continue
    const id = node.segment_ids[0]
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    fill.push(id)
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
        isKeySkeletonNode(node.kind) &&
        node.segment_ids.length > 0 &&
        !node.segment_ids.some((id) => visibleIds.has(id)),
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
