import { decideCut, failClosedKeep } from '../domain/cut_decision.ts'
import { isResolvedByRules, type LabelDecision } from '../domain/label_decision.ts'
import type { AgentView } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import type { CutWarrant, CutWarrantEntry } from '../types/cut_warrant.ts'
import type { RawTrace } from '../types/raw_trace.ts'
import type { SegmentCard } from '../types/segment.ts'
import { assemble } from './assembler.ts'
import { applyRules } from './rules.ts'
import { segment } from './segmenter.ts'

export type DistillMode = 'no_llm' | 'full'

export interface DistillInput {
  /** 已过 Admission Gate。 */
  raw: RawTrace
  profile: CutProfile
  mode: DistillMode
}

export interface DistillResult {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  plan: CutPlan
  training: TrainingCut
  playback: PlaybackCut
  decisions: LabelDecision[]
  unresolved_ids: string[]
  /** data 层指标行；落库由 service 调 data，本函数不写 SQLite。 */
  metrics_ref: string
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/**
 * 确定性编排。本阶段只落地 mode='no_llm'：
 * segment → applyRules → 纯代码 CutWarrant → assemble。
 * 禁止 import pi；洞 A/B 只留调用点注释。
 */
export async function distill(input: DistillInput): Promise<DistillResult> {
  const { raw, profile, mode } = input
  const segmented = segment(raw)
  const ruled = applyRules({ view: segmented, raw })

  if (mode !== 'no_llm') {
    /*
     * TODO(hole A): 调 src/agent/sessions/skeleton_pass.ts 的 skeletonPass。
     *   输入 raw.anchor_turn_ids（头 1–2 turn + 验证点附近），
     *   输出 intent_hypothesis v0 + skeleton v0 + scenario。
     *   接口占位： skeletonPass(raw: RawTrace) → Promise<{ intent, skeleton }>
     *   只经 sessions 工厂；本文件不得 import pi / createAgentSession。
     *
     * TODO(hole B): 调 src/agent/sessions/label_window.ts 的 labelWindow。
     *   仅 unresolved_ids，按 LABEL_WINDOW_SIZE 切窗串行；
     *   规则已决议（isResolvedByRules）的段跳过。
     *   窗解析失败 / 超 token → 该窗 failClosedKeep。
     *   接口占位： labelWindow({ segments, skeleton, skill }) → Promise<LabelDecision[]>
     *
     * TODO(writeWarrant LLM)：若以后走洞 A 二次调用，放 sessions/write_warrant.ts；
     *   no_llm 路径继续用本文件的纯代码凭证。
     */
    throw new NotImplementedError(
      `distill mode '${mode}' is not implemented; hole A/B sessions are out of scope`,
    )
  }

  const warrant = writeConservativeWarrant({
    trace_id: raw.meta.trace_id,
    segments: ruled.view.segments,
    decisions: ruled.decisions,
    profile,
  })
  const assembled = assemble({ raw, view: ruled.view, warrant, profile })

  return {
    raw,
    view: ruled.view,
    warrant,
    plan: assembled.plan,
    training: assembled.training,
    playback: assembled.playback,
    decisions: ruled.decisions,
    unresolved_ids: ruled.unresolved_ids,
    metrics_ref: '',
  }
}

/**
 * 已决议段按 profile 映射 keep/collapse/drop；未决段 Fail-Closed Keep。
 * 不调 pi / sessions。
 */
function writeConservativeWarrant(args: {
  trace_id: string
  segments: SegmentCard[]
  decisions: LabelDecision[]
  profile: CutProfile
}): CutWarrant {
  const byId = new Map(args.decisions.map((d) => [d.segment_id, d]))
  const entries: CutWarrantEntry[] = args.segments.map((seg) => {
    const labeled = byId.get(seg.id)
    if (labeled === undefined || !isResolvedByRules(labeled)) {
      return toEntry(failClosedKeep(seg.id, args.profile.id))
    }
    return toEntry(decideCut(labeled, args.profile, seg))
  })
  return { trace_id: args.trace_id, entries }
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
