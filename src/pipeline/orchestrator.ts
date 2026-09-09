import { labelWindow, type SkeletonPatch } from '../agent/sessions/label_window.ts'
import {
  hasInjectedSessionBackend,
  holeModelsConfigured,
  skeletonPass,
  type SessionBackend,
} from '../agent/sessions/skeleton_pass.ts'
import { writeWarrant } from '../agent/sessions/write_warrant.ts'
import { resolveSkillRoute } from '../constant/skill_route.ts'
import { LABEL_WINDOW_SIZE, REVIEW_MAX_ROUNDS } from '../constant/window.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../domain/cut_decision.ts'
import type { LabelDecision } from '../domain/label_decision.ts'
import { reviewAgainstPlan } from '../eval/review_fill.ts'
import type { AgentView, Skeleton } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import type { CutWarrant } from '../types/cut_warrant.ts'
import type { RawTrace } from '../types/raw_trace.ts'
import { assemble, type AssembleOutput } from './assembler.ts'
import { applyRules } from './rules.ts'
import { segment } from './segmenter.ts'

export type DistillMode = 'no_llm' | 'with_llm'

export interface DistillOpts {
  sessionBackend?: SessionBackend
}

export interface DistillInput {
  /** 已过 Admission Gate。 */
  raw: RawTrace
  profile: CutProfile
  mode: DistillMode
  opts?: DistillOpts
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
 * 无 --no-llm 且（注入了假后端或洞模型 env）时走 with_llm，否则保守 no_llm。
 */
export function resolveDistillMode(input: {
  no_llm?: boolean
  sessionBackend?: SessionBackend
  env?: NodeJS.Dict<string>
}): DistillMode {
  if (input.no_llm === true) return 'no_llm'
  if (input.sessionBackend !== undefined) return 'with_llm'
  if (hasInjectedSessionBackend()) return 'with_llm'
  if (holeModelsConfigured(input.env ?? process.env)) return 'with_llm'
  return 'no_llm'
}

/**
 * 确定性编排。mode='no_llm'：规则 + 未决 Fail-Closed Keep。
 * mode='with_llm'：洞 A → 逐窗洞 B → 凭证 → assemble → 盲测纯代码回填。
 * 禁止 import pi SDK；洞只经 sessions 函数。
 */
export async function distill(input: DistillInput): Promise<DistillResult> {
  const { raw, profile, mode } = input
  const backend = input.opts?.sessionBackend
  const segmented = segment(raw)
  const ruled = applyRules({ view: segmented, raw })

  if (mode === 'no_llm') {
    const warrant = writeWarrant({
      skeleton: ruled.view.skeleton,
      labels: ruled.decisions,
      view: ruled.view,
      profile,
    })
    const assembled = assemble({ raw, view: ruled.view, warrant, profile })
    return packResult({
      raw,
      view: ruled.view,
      warrant,
      assembled,
      decisions: ruled.decisions,
      unresolved_ids: ruled.unresolved_ids,
    })
  }

  return await runWithLlm({
    raw,
    profile,
    ruled,
    ...(backend !== undefined ? { backend } : {}),
  })
}

async function runWithLlm(input: {
  raw: RawTrace
  profile: CutProfile
  ruled: ReturnType<typeof applyRules>
  backend?: SessionBackend
}): Promise<DistillResult> {
  const { raw, profile, ruled, backend } = input
  const anchors = splitAnchorTurnIds(raw)
  const holeA = await skeletonPass({
    trace_id: raw.meta.trace_id,
    head_turn_ids: anchors.head_turn_ids,
    verification_turn_ids: anchors.verification_turn_ids,
    raw,
    view: ruled.view,
    ...(backend !== undefined ? { backend } : {}),
  })

  let skeleton: Skeleton = holeA.skeleton
  let view: AgentView = {
    ...ruled.view,
    intent_hypothesis: holeA.intent,
    skeleton,
  }

  const route = resolveSkillRoute(holeA.scenario)
  const llmDecisions: LabelDecision[] = []
  const stillUnresolved: string[] = []

  for (const windowIds of chunkIds(ruled.unresolved_ids, LABEL_WINDOW_SIZE)) {
    try {
      const labeled = await labelWindow({
        segment_ids: windowIds,
        view,
        raw,
        skeleton,
        intent: view.intent_hypothesis,
        skill_path: route.path,
        ...(backend !== undefined ? { backend } : {}),
      })
      llmDecisions.push(...labeled.decisions)
      stillUnresolved.push(...labeled.still_unlabeled)
      skeleton = applySkeletonPatch(skeleton, labeled.skeleton_patch)
      view = { ...view, skeleton }
    } catch {
      stillUnresolved.push(...windowIds)
    }
  }

  const decisions = [...ruled.decisions, ...llmDecisions]
  view = { ...view, skeleton }
  let warrant = writeWarrant({
    skeleton: view.skeleton,
    labels: decisions,
    view,
    profile,
  })
  const reviewed = runBlindReviewFillIn({ raw, view, warrant, profile })
  warrant = reviewed.warrant

  return packResult({
    raw,
    view,
    warrant,
    assembled: reviewed.assembled,
    decisions,
    unresolved_ids: stillUnresolved,
  })
}

/** 头 1–2 turn（含首条 user）vs 其余锚点（验证点附近）。 */
export function splitAnchorTurnIds(raw: RawTrace): {
  head_turn_ids: string[]
  verification_turn_ids: string[]
} {
  const firstUser = raw.turns.find((t) => t.role === 'user')
  const headSet = new Set<string>()
  if (firstUser !== undefined) {
    const idx = raw.turns.findIndex((t) => t.id === firstUser.id)
    const first = raw.turns[idx]
    const second = raw.turns[idx + 1]
    if (first !== undefined) headSet.add(first.id)
    if (second !== undefined) headSet.add(second.id)
  }
  const head_turn_ids = raw.anchor_turn_ids.filter((id) => headSet.has(id))
  const verification_turn_ids = raw.anchor_turn_ids.filter((id) => !headSet.has(id))
  return { head_turn_ids, verification_turn_ids }
}

export function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size))
  }
  return out
}

export function applySkeletonPatch(skeleton: Skeleton, patch: SkeletonPatch | undefined): Skeleton {
  if (patch === undefined) return skeleton
  const removed = new Set(patch.remove_node_ids)
  const nodes: Skeleton['nodes'] = []
  const seen = new Set<string>()
  for (const node of skeleton.nodes) {
    if (removed.has(node.id)) continue
    const upsert = patch.upsert_nodes.find((n) => n.id === node.id)
    const next = upsert ?? node
    nodes.push(next)
    seen.add(next.id)
  }
  for (const node of patch.upsert_nodes) {
    if (removed.has(node.id) || seen.has(node.id)) continue
    nodes.push(node)
    seen.add(node.id)
  }
  return { version: skeleton.version + 1, nodes }
}

export function fillInKeepWarrant(warrant: CutWarrant, segmentIds: readonly string[]): CutWarrant {
  const fill = new Set(segmentIds)
  return {
    trace_id: warrant.trace_id,
    entries: warrant.entries.map((entry) => {
      if (!fill.has(entry.segment_id) || entry.action === 'keep') return entry
      return {
        segment_id: entry.segment_id,
        action: 'keep',
        source: { kind: 'rule', name: FAIL_CLOSED_KEEP_RULE },
        confidence: 1,
      }
    }),
  }
}

/**
 * 盲测回填：缺骨架节点则对应段改 keep 再 assemble。最多 REVIEW_MAX_ROUNDS 轮。
 */
export function runBlindReviewFillIn(input: {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  profile: CutProfile
}): { warrant: CutWarrant; assembled: AssembleOutput; rounds: number } {
  let warrant = input.warrant
  let assembled = assemble({
    raw: input.raw,
    view: input.view,
    warrant,
    profile: input.profile,
  })
  let rounds = 0
  while (rounds < REVIEW_MAX_ROUNDS) {
    const review = reviewAgainstPlan(input.view.skeleton, assembled.plan)
    if (review.fill_in_segment_ids.length === 0) break
    rounds += 1
    warrant = fillInKeepWarrant(warrant, review.fill_in_segment_ids)
    assembled = assemble({
      raw: input.raw,
      view: input.view,
      warrant,
      profile: input.profile,
    })
  }
  return { warrant, assembled, rounds }
}

function packResult(input: {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  assembled: AssembleOutput
  decisions: LabelDecision[]
  unresolved_ids: string[]
}): DistillResult {
  return {
    raw: input.raw,
    view: input.view,
    warrant: input.warrant,
    plan: input.assembled.plan,
    training: input.assembled.training,
    playback: input.assembled.playback,
    decisions: input.decisions,
    unresolved_ids: input.unresolved_ids,
    metrics_ref: '',
  }
}
