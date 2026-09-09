import { SPAN_MAX_GAP_SEGMENTS } from '../constant/window.ts'
import { SpanFailure, type SpanViolation } from '../domain/span_violation.ts'
import type { AgentView } from '../types/agent_view.ts'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan.ts'
import type { CutProfile } from '../types/cut_profile.ts'
import type { CutWarrant, CutWarrantEntry } from '../types/cut_warrant.ts'
import type { RawTrace, RawTurn } from '../types/raw_trace.ts'
import type { SegmentCard } from '../types/segment.ts'
import { stableHash } from '../utils/hash.ts'
import { estimateTokens } from '../utils/tokens.ts'

export interface ContinuityScore {
  left: string
  right: string
  score: number
  ok: boolean
}

export interface AssembleInput {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  profile: CutProfile
  /** 可选：洞 B 已打过的相邻对分数。缺省不调洞。 */
  continuity?: ContinuityScore[]
}

export interface AssembleOutput {
  plan: CutPlan
  training: TrainingCut
  playback: PlaybackCut
}

export class WarrantCoverageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WarrantCoverageError'
  }
}

/**
 * 执行 CutWarrant：按原序 keep / collapse / drop，强制 span，同源投影双产物。
 * warrant 是最终动作；不改 keep 原文；不调 pi / SQLite。
 */
export function assemble(input: AssembleInput): AssembleOutput {
  const { raw, view, warrant, profile } = input
  const byId = indexEntries(view, warrant)
  const indexOf = new Map(view.segments.map((seg, i) => [seg.id, i]))
  const turnById = new Map(raw.turns.map((t) => [t.id, t]))

  const kept: string[] = []
  const collapsed: CutPlan['collapsed'] = []
  const dropped: string[] = []
  const steps: string[] = []

  for (const seg of view.segments) {
    const entry = byId.get(seg.id)
    if (entry === undefined) {
      throw new WarrantCoverageError(`warrant missing segment ${seg.id}`)
    }
    if (entry.action === 'keep') {
      kept.push(seg.id)
      steps.push(seg.id)
    } else if (entry.action === 'collapse') {
      const summary = entry.dead_end_summary
      if (summary === undefined || summary.length === 0) {
        throw new WarrantCoverageError(`collapse ${seg.id} missing dead_end_summary`)
      }
      collapsed.push({ segment_id: seg.id, summary })
      steps.push(seg.id)
    } else {
      dropped.push(seg.id)
    }
  }

  const continuity = indexContinuity(input.continuity)
  const violations = checkSpan(steps, indexOf, continuity)

  const warrant_ref = stableHash(JSON.stringify(warrant))
  const plan: CutPlan = {
    trace_id: view.meta.trace_id,
    profile_id: profile.id,
    warrant_ref,
    kept,
    collapsed,
    dropped,
    span_ok: violations.length === 0,
    span_violations: violations.map((v) => v.id),
  }

  if (violations.length > 0) {
    throw new SpanFailure(plan, violations)
  }

  const plan_ref = stableHash(JSON.stringify(plan))
  const trainingTurns: RawTurn[] = []
  const playbackCards: SegmentCard[] = []

  for (const seg of view.segments) {
    const entry = byId.get(seg.id)
    if (entry === undefined) continue
    if (entry.action === 'drop') continue
    if (entry.action === 'collapse') {
      const summary = entry.dead_end_summary ?? ''
      trainingTurns.push(collapseTurn(seg.id, summary))
      continue
    }
    playbackCards.push(cloneCard(seg))
    for (const ref of seg.raw_refs) {
      const turn = turnById.get(ref)
      if (turn === undefined) {
        throw new WarrantCoverageError(`segment ${seg.id} raw_ref ${ref} missing from RawTrace`)
      }
      trainingTurns.push(turn)
    }
  }

  return {
    plan,
    training: { trace_id: plan.trace_id, plan_ref, turns: trainingTurns },
    playback: {
      trace_id: plan.trace_id,
      plan_ref,
      cards: playbackCards,
      collapsed: collapsed.map((c) => ({ ...c })),
    },
  }
}

function indexEntries(view: AgentView, warrant: CutWarrant): Map<string, CutWarrantEntry> {
  const ids = view.segments.map((s) => s.id)
  const idSet = new Set(ids)
  const byId = new Map<string, CutWarrantEntry>()
  for (const entry of warrant.entries) {
    if (!idSet.has(entry.segment_id)) {
      throw new WarrantCoverageError(`warrant has unknown segment ${entry.segment_id}`)
    }
    if (byId.has(entry.segment_id)) {
      throw new WarrantCoverageError(`warrant duplicates segment ${entry.segment_id}`)
    }
    byId.set(entry.segment_id, entry)
  }
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new WarrantCoverageError(`warrant missing segment(s): ${missing.join(', ')}`)
  }
  return byId
}

function indexContinuity(
  rows: ContinuityScore[] | undefined,
): Map<string, ContinuityScore> {
  const map = new Map<string, ContinuityScore>()
  if (rows === undefined) return map
  for (const row of rows) {
    map.set(`${row.left}\0${row.right}`, row)
  }
  return map
}

/**
 * 相邻 keep 的跨度：collapse 占位算一步。gap = 两步之间的原段数（均为 drop）。
 * 阈值用 SPAN_MAX_GAP_SEGMENTS（OPEN 命名常量）。
 */
function checkSpan(
  steps: string[],
  indexOf: Map<string, number>,
  continuity: Map<string, ContinuityScore>,
): SpanViolation[] {
  const violations: SpanViolation[] = []
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const left = steps[i]
    const right = steps[i + 1]
    if (left === undefined || right === undefined) continue
    const li = indexOf.get(left)
    const ri = indexOf.get(right)
    if (li === undefined || ri === undefined) continue
    const gap_segments = ri - li - 1
    const cont = continuity.get(`${left}\0${right}`)
    const tooFar = gap_segments > SPAN_MAX_GAP_SEGMENTS
    const continuityFail = cont !== undefined && !cont.ok
    if (!tooFar && !continuityFail) continue

    const violation: SpanViolation = {
      id: `span:${left}:${right}`,
      left_segment_id: left,
      right_segment_id: right,
      gap_segments,
      reason: tooFar ? 'gap_too_large' : 'continuity_fail',
    }
    if (cont !== undefined) {
      violation.continuity_score = cont.score
    }
    violations.push(violation)
  }
  return violations
}

function collapseTurn(segmentId: string, summary: string): RawTurn {
  return {
    id: `collapse:${segmentId}`,
    role: 'assistant',
    content: summary,
    tokens: estimateTokens(summary),
  }
}

function cloneCard(seg: SegmentCard): SegmentCard {
  return { ...seg, reads: [...seg.reads], writes: [...seg.writes], raw_refs: [...seg.raw_refs] }
}
