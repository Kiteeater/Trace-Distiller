import { labelWindow, type SkeletonPatch } from '../agent/sessions/label_window.ts'
import {
  hasInjectedSessionBackend,
  holeModelsConfigured,
  skeletonPass,
  type SessionBackend,
} from '../agent/sessions/skeleton_pass.ts'
import { writeWarrant } from '../agent/sessions/write_warrant.ts'
import { resolveSkillRoute } from '../constant/skill_route.ts'
import {
  KEEP_FLOOR_MIN_ORIGINAL_TOKENS,
  KEEP_RATIO_FLOOR,
  KEEP_RATIO_SOFT_CAP,
} from '../constant/compression.ts'
import { LABEL_WINDOW_SIZE, REVIEW_MAX_ROUNDS } from '../constant/window.ts'
import { FAIL_CLOSED_KEEP_RULE } from '../domain/cut_decision.ts'
import { isSpanFailure } from '../domain/span_violation.ts'
import type { LabelDecision } from '../domain/label_decision.ts'
import { compressionRatio } from '../eval/metrics.ts'
import { reviewAgainstPlan } from '../eval/review_fill.ts'
import type { AgentView, Skeleton } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import type { CutWarrant } from '../types/cut_warrant.ts'
import type { RawTrace } from '../types/raw_trace.ts'
import { assemble, type AssembleOutput } from './assembler.ts'
import { applyRules } from './rules.ts'
import { segment } from './segmenter.ts'
import { warn as logWarn } from '../utils/logger.ts'

/** Agent-led path only (ADR-0010). `--no_llm` / rules-only removed. */
export type DistillMode = 'with_llm'

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
  /** 仅 hole_a + hole_b 用量；L4 不计。缺省 0。 */
  hole_a_plus_b_tokens?: number
  /** 洞窗口失败等可观测备注；不改变 Fail-Closed Keep 语义。 */
  hole_notes?: string[]
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/** Error when callers pass the removed `--no-llm` flag (ADR-0010). */
export const NO_LLM_REMOVED_MESSAGE =
  '--no-llm was removed (ADR-0010; see docs/adr/0010-agent-led-cut-with-tool-mask.md). Agent-led cut is required; use FakeSessionBackend / --fake-l4 for CI, or set TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B.'

export const AGENT_PATH_REQUIRED_MESSAGE =
  'Agent path required (ADR-0010): set TRACE_DISTILLER_MODEL_HOLE_A / TRACE_DISTILLER_MODEL_HOLE_B, or inject FakeSessionBackend / --fake-l4. Pure rules-only --no-llm was removed.'

/**
 * Always agent path (`with_llm`). `--no-llm` throws. Missing backend+models throws (no silent rules-only fallback).
 */
export function resolveDistillMode(input: {
  no_llm?: boolean
  sessionBackend?: SessionBackend
  env?: NodeJS.Dict<string>
}): DistillMode {
  if (input.no_llm === true) {
    throw new Error(NO_LLM_REMOVED_MESSAGE)
  }
  if (input.sessionBackend !== undefined) return 'with_llm'
  if (hasInjectedSessionBackend()) return 'with_llm'
  if (holeModelsConfigured(input.env ?? process.env)) return 'with_llm'
  throw new Error(AGENT_PATH_REQUIRED_MESSAGE)
}

/**
 * Agent-led 编排（ADR-0010）。mode 仅 'with_llm'：洞 A → 逐窗洞 B → 凭证 → assemble → 盲测纯代码回填。
 * 规则仍先跑作 hints；最终 how-to-cut 由 agent 洞决议（未决 Fail-Closed Keep 仍是 failure policy）。
 * 禁止 import pi SDK；洞只经 sessions 函数。完整 cut-brain ReAct 循环见 ADR-0010 follow-up。
 */
export async function distill(input: DistillInput): Promise<DistillResult> {
  const { raw, profile, mode } = input
  if (mode !== 'with_llm') {
    throw new Error(NO_LLM_REMOVED_MESSAGE)
  }
  const backend = input.opts?.sessionBackend
  const segmented = segment(raw)
  const ruled = applyRules({ view: segmented, raw })

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
  const holeNotes: string[] = []
  let holeTokens =
    holeA.usage.input_tokens + holeA.usage.output_tokens

  const windowSize =
    typeof profile.label_window_size === 'number' &&
    Number.isFinite(profile.label_window_size) &&
    profile.label_window_size > 0
      ? Math.floor(profile.label_window_size)
      : LABEL_WINDOW_SIZE
  for (const windowIds of chunkIds(ruled.unresolved_ids, windowSize)) {
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
      holeTokens += labeled.usage.input_tokens + labeled.usage.output_tokens
      skeleton = applySkeletonPatch(skeleton, labeled.skeleton_patch)
      view = { ...view, skeleton }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const note = `hole_b_window_failed:${windowIds.join(',')}:${message}`
      holeNotes.push(note)
      logWarn(note)
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
  const floored = enforceKeepRatioFloor({
    raw,
    view,
    warrant: reviewed.warrant,
    profile,
  })
  warrant = floored.warrant

  return packResult({
    raw,
    view,
    warrant,
    assembled: floored.assembled,
    decisions,
    unresolved_ids: stillUnresolved,
    hole_a_plus_b_tokens: holeTokens,
    ...(holeNotes.length > 0 ? { hole_notes: holeNotes } : {}),
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
  let repaired = assembleRepairingSpan({
    raw: input.raw,
    view: input.view,
    warrant,
    profile: input.profile,
  })
  warrant = repaired.warrant
  let assembled = repaired.assembled
  let rounds = 0
  while (rounds < REVIEW_MAX_ROUNDS) {
    const review = reviewAgainstPlan(input.view.skeleton, assembled.plan)
    if (review.fill_in_segment_ids.length === 0) break
    rounds += 1
    warrant = fillInKeepWarrant(warrant, review.fill_in_segment_ids)
    repaired = assembleRepairingSpan({
      raw: input.raw,
      view: input.view,
      warrant,
      profile: input.profile,
    })
    warrant = repaired.warrant
    assembled = repaired.assembled
  }
  return { warrant, assembled, rounds }
}


/**
 * Soft keep floor: avoid crushing cut_tokens/original below KEEP_RATIO_FLOOR (~8%).
 * Promotes dropped segments that best shrink large keep↔keep gaps (coherence-friendly).
 * Does not drop gold; only adds keep. Blind-review key fill-in runs first.
 */
/**
 * Assemble; on SpanFailure promote dropped segments in the largest gap (same
 * picker as keep floor) until span is ok or no candidates remain.
 * Softens nearly-uncut MIMO paths where write_warrant dead_end fill cannot
 * bridge routine drops before keep-floor runs.
 */
export function assembleRepairingSpan(input: {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  profile: CutProfile
}): { warrant: CutWarrant; assembled: AssembleOutput; filled_ids: string[] } {
  let warrant = input.warrant
  const filled_ids: string[] = []
  let guard = 0
  while (guard <= input.view.segments.length) {
    guard += 1
    try {
      const assembled = assemble({
        raw: input.raw,
        view: input.view,
        warrant,
        profile: input.profile,
      })
      return { warrant, assembled, filled_ids }
    } catch (error) {
      if (!isSpanFailure(error)) throw error
      const next = pickDroppedForKeepFloor(error.plan, input.view.segments)
      if (next === undefined) throw error
      filled_ids.push(next)
      warrant = fillInKeepWarrant(warrant, [next])
      logWarn(
        `span_repair:keep:${next}:violations=${String(error.violations.length)}`,
      )
    }
  }
  // Exhausted — surface the last assemble attempt.
  const assembled = assemble({
    raw: input.raw,
    view: input.view,
    warrant,
    profile: input.profile,
  })
  return { warrant, assembled, filled_ids }
}

export function enforceKeepRatioFloor(input: {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  profile: CutProfile
  min_ratio?: number
}): { warrant: CutWarrant; assembled: AssembleOutput; filled_ids: string[] } {
  const profileFloor = input.profile.keep_ratio_floor
  // Explicit null on profile (short valve) → skip keep floor (still repair span).
  if (profileFloor === null && input.min_ratio === undefined) {
    return assembleRepairingSpan({
      raw: input.raw,
      view: input.view,
      warrant: input.warrant,
      profile: input.profile,
    })
  }
  const minRatio = input.min_ratio ?? (typeof profileFloor === 'number' ? profileFloor : KEEP_RATIO_FLOOR)
  const repaired = assembleRepairingSpan({
    raw: input.raw,
    view: input.view,
    warrant: input.warrant,
    profile: input.profile,
  })
  let warrant = repaired.warrant
  let assembled = repaired.assembled
  const filled_ids = [...repaired.filled_ids]
  const original = input.raw.meta.total_tokens
  if (original <= 0) return { warrant, assembled, filled_ids }
  // Short / small traces: skip floor — one large segment can leap past compression_ratio_max.
  if (original < KEEP_FLOOR_MIN_ORIGINAL_TOKENS) return { warrant, assembled, filled_ids }

  const cutTokens = (): number =>
    assembled.training.turns.reduce((sum, t) => sum + t.tokens, 0)
  const ratioOf = (): number =>
    compressionRatio({
      original_tokens: original,
      cut_tokens: cutTokens(),
    })
  const segmentTokens = (id: string): number => {
    const seg = input.view.segments.find((s) => s.id === id)
    return seg?.tokens ?? 0
  }

  let guard = 0
  while (ratioOf() < minRatio && guard < input.view.segments.length) {
    guard += 1
    const next = pickDroppedForKeepFloor(assembled.plan, input.view.segments)
    if (next === undefined) break
    const projected = compressionRatio({
      original_tokens: original,
      cut_tokens: cutTokens() + segmentTokens(next),
    })
    // Stay inside ~8–15% band when possible; do not blow past soft cap.
    if (projected > KEEP_RATIO_SOFT_CAP) break
    filled_ids.push(next)
    warrant = fillInKeepWarrant(warrant, [next])
    const again = assembleRepairingSpan({
      raw: input.raw,
      view: input.view,
      warrant,
      profile: input.profile,
    })
    warrant = again.warrant
    assembled = again.assembled
    filled_ids.push(...again.filled_ids)
  }
  return { warrant, assembled, filled_ids }
}

/** Prefer a dropped segment inside the largest gap between kept/collapsed steps. */
export function pickDroppedForKeepFloor(
  plan: CutPlan,
  segments: AgentView['segments'],
): string | undefined {
  const dropped = new Set(plan.dropped)
  if (dropped.size === 0) return undefined
  const indexOf = new Map(segments.map((seg, i) => [seg.id, i]))
  const stepIds = [
    ...plan.kept,
    ...plan.collapsed.map((c) => c.segment_id),
  ].sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0))

  let bestId: string | undefined
  let bestGap = -1
  const considerGap = (fromIdx: number, toIdx: number): void => {
    const gap = toIdx - fromIdx - 1
    if (gap <= 0 || gap < bestGap) return
    const mid = fromIdx + Math.ceil(gap / 2)
    for (let dist = 0; dist <= gap; dist += 1) {
      for (const idx of [mid + dist, mid - dist]) {
        if (idx <= fromIdx || idx >= toIdx) continue
        const seg = segments[idx]
        if (seg === undefined || !dropped.has(seg.id)) continue
        bestGap = gap
        bestId = seg.id
        return
      }
    }
  }

  if (stepIds.length === 0) {
    // Nothing kept: take a mid segment.
    const mid = segments[Math.floor(segments.length / 2)]
    return mid !== undefined && dropped.has(mid.id) ? mid.id : [...dropped][0]
  }

  const firstIdx = indexOf.get(stepIds[0]!)
  if (firstIdx !== undefined && firstIdx > 0) considerGap(-1, firstIdx)
  for (let i = 0; i + 1 < stepIds.length; i += 1) {
    const li = indexOf.get(stepIds[i]!)
    const ri = indexOf.get(stepIds[i + 1]!)
    if (li === undefined || ri === undefined) continue
    considerGap(li, ri)
  }
  const lastIdx = indexOf.get(stepIds[stepIds.length - 1]!)
  if (lastIdx !== undefined && lastIdx + 1 < segments.length) {
    considerGap(lastIdx, segments.length)
  }

  if (bestId !== undefined) return bestId
  return plan.dropped[0]
}


function packResult(input: {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  assembled: AssembleOutput
  decisions: LabelDecision[]
  unresolved_ids: string[]
  hole_a_plus_b_tokens?: number
  hole_notes?: string[]
}): DistillResult {
  const out: DistillResult = {
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
  if (input.hole_a_plus_b_tokens !== undefined) {
    out.hole_a_plus_b_tokens = input.hole_a_plus_b_tokens
  }
  if (input.hole_notes !== undefined && input.hole_notes.length > 0) {
    out.hole_notes = input.hole_notes
  }
  return out
}
