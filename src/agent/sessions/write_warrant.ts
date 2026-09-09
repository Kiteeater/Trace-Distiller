import { decideCut, failClosedKeep } from '../../domain/cut_decision.ts'
import type { LabelDecision } from '../../domain/label_decision.ts'
import type { AgentView, Skeleton } from '../../types/agent_view.ts'
import type { CutProfile } from '../../types/cut_profile.ts'
import type { CutWarrant, CutWarrantEntry } from '../../types/cut_warrant.ts'

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
 * 已决议段按 CutProfile → keep/collapse/drop；未出现在 labels 里的段 Fail-Closed Keep。
 * 覆盖 view.segments 每一个 id。形状与 assembler 吃的 CutWarrant 一致。
 */
export function writeWarrant(input: WriteWarrantInput): CutWarrant {
  void input.skeleton
  const byId = new Map(input.labels.map((d) => [d.segment_id, d]))
  const entries: CutWarrantEntry[] = input.view.segments.map((seg) => {
    const labeled = byId.get(seg.id)
    if (labeled === undefined) {
      return toEntry(failClosedKeep(seg.id, input.profile.id))
    }
    return toEntry(decideCut(labeled, input.profile, seg))
  })
  return { trace_id: input.view.meta.trace_id, entries }
}

function toEntry(decision: ReturnType<typeof decideCut>): CutWarrantEntry {
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
