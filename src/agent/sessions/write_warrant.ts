import {
  deadEndSummary,
  decideCut,
  failClosedKeep,
  type CutDecision,
} from '../../domain/cut_decision.ts'
import type { LabelDecision } from '../../domain/label_decision.ts'
import type { AgentView, Skeleton } from '../../types/agent_view.ts'
import type { CutProfile } from '../../types/cut_profile.ts'
import type { CutWarrant, CutWarrantEntry } from '../../types/cut_warrant.ts'
import type { SegmentCard } from '../../types/segment.ts'

/**
 * 洞 A 二次调用的数据形状保留；实现改为纯代码汇总。
 * 不调 pi。骨架字段只占位，去留完全由 LabelDecision + profile 决定。
 */
export interface WriteWarrantInput {
  skeleton: Skeleton
  labels: LabelDecision[]
  view: AgentView
  profile: CutProfile
}

/**
 * 已决议段按 CutProfile → keep/collapse/drop。
 * 未出现在 labels 里的段 Fail-Closed Keep（ADR-0010：agent/tool failure policy，
 * 不是「规则优先静默 keep」）。规则标签只能来自 cut-brain 已采纳的 apply_rules_hint
 * 或调用方显式传入的 labels，writeWarrant 自身不跑 applyRules。
 * 覆盖 view.segments 每一个 id。形状与 assembler 吃的 CutWarrant 一致。
 *
 * 死胡同代表策略（CutProfile.dead_end / span.fill_with_representative_dead_end）：
 * - 相似重试成员（rep_of != null）默认 drop，避免每个重试都留一句摘要；
 * - 代表 / 单条 dead_end 最多 collapse `max_representative` 条，多余 drop；
 * - 若开启 fill_with_representative_dead_end，为满足 span 缺口再把缺口内的 dead_end 提回 collapse；
 * - 最后一个 keep 之后的 trailing dead_end collapse 再 drop（不参与 keep↔keep span）。
 */
export function writeWarrant(input: WriteWarrantInput): CutWarrant {
  void input.skeleton
  const byId = new Map(input.labels.map((d) => [d.segment_id, d]))
  const decisions: CutDecision[] = input.view.segments.map((seg) => {
    const labeled = byId.get(seg.id)
    if (labeled === undefined) {
      return failClosedKeep(seg.id, input.profile.id)
    }
    return decideCut(labeled, input.profile, seg)
  })

  applyDeadEndRepresentativePolicy(decisions, input.view.segments, input.profile)
  dropTrailingDeadEndCollapses(decisions, input.view.segments)

  return {
    trace_id: input.view.meta.trace_id,
    entries: decisions.map(toEntry),
  }
}

function toEntry(decision: CutDecision): CutWarrantEntry {
  const entry: CutWarrantEntry = {
    segment_id: decision.segment_id,
    action: decision.action,
    source: decision.source,
    confidence: decision.confidence,
  }
  if (decision.dead_end_summary !== undefined) {
    entry.dead_end_summary = decision.dead_end_summary
  }
  return entry
}

function applyDeadEndRepresentativePolicy(
  decisions: CutDecision[],
  segments: SegmentCard[],
  profile: CutProfile,
): void {
  const cardById = new Map(segments.map((s) => [s.id, s]))
  const indexOf = new Map(segments.map((s, i) => [s.id, i]))

  // 1) Cluster members are covered by their representative → drop.
  for (const d of decisions) {
    if (d.action !== 'collapse') continue
    const card = cardById.get(d.segment_id)
    if (card?.rep_of != null) {
      demoteToDrop(d)
    }
  }

  // 2) Cap representative collapses (chronological) at max_representative.
  const maxRep = profile.dead_end.max_representative
  if (typeof maxRep === 'number' && Number.isFinite(maxRep) && maxRep >= 0) {
    let kept = 0
    for (const d of decisions) {
      if (d.action !== 'collapse') continue
      kept += 1
      if (kept > maxRep) demoteToDrop(d)
    }
  }

  // 3) Span fill: re-collapse dropped dead_ends so adjacent keep/collapse gaps stay reachable.
  if (!profile.span.fill_with_representative_dead_end) return
  const maxGap = profile.span.max_gap_segments
  if (typeof maxGap !== 'number' || !Number.isFinite(maxGap) || maxGap < 0) return

  let guard = 0
  while (guard < segments.length) {
    guard += 1
    const steps = decisions.filter((d) => d.action === 'keep' || d.action === 'collapse')
    let promoted = false
    for (let i = 0; i + 1 < steps.length; i += 1) {
      const left = steps[i]
      const right = steps[i + 1]
      if (left === undefined || right === undefined) continue
      const li = indexOf.get(left.segment_id)
      const ri = indexOf.get(right.segment_id)
      if (li === undefined || ri === undefined) continue
      const gap = ri - li - 1
      if (gap <= maxGap) continue

      // Place the next collapse at most maxGap segments after left.
      const target = li + maxGap + 1
      const candidate = findDroppableDeadEnd(decisions, segments, li + 1, ri, target)
      if (candidate === undefined) continue
      promoteToCollapse(candidate, cardById.get(candidate.segment_id), profile)
      promoted = true
      break
    }
    if (!promoted) break
  }
}

function findDroppableDeadEnd(
  decisions: CutDecision[],
  segments: SegmentCard[],
  fromExclusive: number,
  toExclusive: number,
  preferIdx: number,
): CutDecision | undefined {
  const inGap: CutDecision[] = []
  for (let i = fromExclusive; i < toExclusive; i += 1) {
    const seg = segments[i]
    if (seg === undefined) continue
    const d = decisions.find((x) => x.segment_id === seg.id)
    if (d === undefined || d.action !== 'drop') continue
    if (d.from_label !== 'dead_end') continue
    inGap.push(d)
  }
  if (inGap.length === 0) return undefined
  const preferId = segments[preferIdx]?.id
  const exact = preferId === undefined ? undefined : inGap.find((d) => d.segment_id === preferId)
  if (exact !== undefined) return exact
  // Nearest to preferred index among gap candidates.
  let best: CutDecision | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (const d of inGap) {
    const idx = segments.findIndex((s) => s.id === d.segment_id)
    if (idx < 0) continue
    const dist = Math.abs(idx - preferIdx)
    if (dist < bestDist) {
      bestDist = dist
      best = d
    }
  }
  return best
}

function demoteToDrop(d: CutDecision): void {
  d.action = 'drop'
  delete d.dead_end_summary
}

function promoteToCollapse(
  d: CutDecision,
  card: SegmentCard | undefined,
  profile: CutProfile,
): void {
  d.action = 'collapse'
  d.dead_end_summary = deadEndSummary(card, profile.dead_end.summary_max_chars)
}

/** keep 包络之外（最后一个 keep 之后）的 dead_end collapse 不服务 span → drop。 */
function dropTrailingDeadEndCollapses(
  decisions: CutDecision[],
  segments: SegmentCard[],
): void {
  const indexOf = new Map(segments.map((s, i) => [s.id, i]))
  let lastKeep = -1
  for (const d of decisions) {
    if (d.action !== 'keep') continue
    const idx = indexOf.get(d.segment_id)
    if (idx === undefined) continue
    if (idx > lastKeep) lastKeep = idx
  }
  if (lastKeep < 0) return
  for (const d of decisions) {
    if (d.action !== 'collapse') continue
    if (d.from_label !== 'dead_end') continue
    const idx = indexOf.get(d.segment_id)
    if (idx === undefined) continue
    if (idx > lastKeep) demoteToDrop(d)
  }
}

