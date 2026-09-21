/**
 * ADR-0017 Hole A decisions via TypeSafe Jev systemOne.
 * Candidate pool, sparse sampling, read_segment, and tool mask stay algorithmic.
 * intent_v0 is a scenario template plus skeleton notes — not generative prose.
 */
import { choice, noul, score, type JsonValue, type Questions } from '@typesafe-ai/sdk'
import {
  JEV_ENOUGH_NOUL_MIN,
  JEV_GAP_ID_CHOICE_MAX,
  JEV_SKELETON_NOUL_MIN,
  SPARSE_INTENT_MAX_ROUNDS,
  SPARSE_INTENT_MAX_SEGMENTS_READ,
  SPARSE_INTENT_MAX_TOKENS,
  SPARSE_INTENT_ROUND_SAMPLE_SIZE,
} from '../../constant/window.ts'
import { resolveSkillRoute } from '../../constant/skill_route.ts'
import type { Scenario } from '../../enums/scenario.ts'
import type { SkeletonNode, SkeletonNodeKind } from '../../types/agent_view.ts'
import type { SegmentCard } from '../../types/segment.ts'
import { type HoleReadContext } from '../extension.ts'
import { executeHoleTool } from '../tools/registry.ts'
import { maskToolResult } from '../prompt/tool_mask.ts'
import { estimateTokens } from '../../utils/tokens.ts'
import { rethrowIfAborted, throwIfAborted } from '../../utils/timeout.ts'
import {
  CANDIDATE_STRATA,
  buildCandidatePool,
  sampleCandidates,
  type CandidateEntry,
  type CandidateStratum,
  type SparseGap,
} from './candidate_pool.ts'
import { createJevClient, type JevAnswer } from './jev_client.ts'
import type { SparseIntentInput, SparseIntentStructured } from './sparse_intent.ts'
import type { TokenUsage } from './skeleton_pass.ts'

export const HOLE_A_JEV_FAKE_NOTE = 'hole_a_decision:jev_fake'
export const HOLE_A_JEV_LIVE_NOTE = 'hole_a_decision:jev_live'
export const INTENT_V0_TEMPLATE_NOTE = 'intent_v0:template'

/** Ordered Score rubric. Index 0 is certain; the last index is insufficient. */
export const JEV_UNCERTAINTY_LEVELS = [
  'Certain. Anchors already read are enough to mark key points.',
  'Mostly clear. One anchor is thin.',
  'Mixed. Unread anchors could change the skeleton.',
  'Unclear. Read excerpts do not show the task.',
  'Insufficient. Almost no segments have been read.',
] as const

/** Same fallbacks as parseSparseIntentJson when uncertainty is omitted. */
const UNCERTAINTY_WHEN_ENOUGH = 0.3
const UNCERTAINTY_WHEN_OPEN = 0.6

const SKELETON_NODE_KINDS = [
  'turning_point',
  'main_path_hypothesis',
  'verification_anchor',
] as const satisfies readonly SkeletonNodeKind[]

const SCENARIO_CRITERIA: Record<Scenario, string> = {
  debug: 'Find and fix a defect in existing behavior',
  implement: 'Add or change behavior to meet a request',
  refactor: 'Restructure code without changing behavior',
  test_fix: 'Change code so a failing test passes',
  investigate: 'Explain or locate something without a required code change',
}

const KIND_CRITERIA: Record<SkeletonNodeKind, string> = {
  turning_point: 'The path changes at this segment',
  main_path_hypothesis: 'A step on the main path',
  verification_anchor: 'A check that the task succeeded',
}

const STRATUM_CRITERIA: Record<CandidateStratum | 'none', string> = {
  head: 'Opening segments of the task',
  verification: 'Checks, tests, or success anchors',
  error_retry: 'Errors and retries',
  tool_failure_dense: 'A dense run of tool failures',
  random_fill: 'Unanchored filler segments',
  none: 'No further stratum is needed',
}

/** v1 intent text. Generative prose is deferred (ADR-0017). */
export function intentTextFromTemplate(
  scenario: Scenario,
  points: readonly { note: string }[],
): string {
  const notes = points
    .map((p) => p.note.trim())
    .filter((note) => note.length > 0)
    .slice(0, 3)
  const head = `${scenario}: sparse skeleton over ${String(points.length)} key point(s)`
  if (notes.length === 0) return head
  return `${head}; ${notes.join('; ')}`
}

/** Map a Jev Score position on 0..levelCount-1 onto uncertainty in 0..1. */
export function uncertaintyFromScore(scoreValue: number, levelCount: number): number {
  if (!Number.isFinite(scoreValue) || levelCount < 2) return 1
  return clamp01(scoreValue / (levelCount - 1))
}

export function buildJevQuestions(input: {
  batchIds: readonly string[]
  unreadIds: readonly string[]
}): Questions {
  const questions: Questions = {
    enough: noul('Is the sampled context enough to mark skeleton key points?', {
      true: 'Head, verification, and any error cluster needed for the task are represented in the read excerpts.',
      false: 'An anchor stratum or a named unread segment is still missing.',
    }),
    scenario: choice('Which scenario code fits this trace?', { ...SCENARIO_CRITERIA }),
    uncertainty: score(
      'How uncertain is the skeleton given the read excerpts?',
      JEV_UNCERTAINTY_LEVELS,
    ),
    next_stratum: choice(
      'If another sample is required, which candidate stratum matters next?',
      { ...STRATUM_CRITERIA },
    ),
  }
  if (input.unreadIds.length > 0 && input.unreadIds.length <= JEV_GAP_ID_CHOICE_MAX) {
    questions.next_gap = choice(
      'Which unread segment id should the next sample include?',
      gapCriteria(input.unreadIds),
    )
  }
  for (const id of input.batchIds) {
    questions[`skel_${id}`] = noul(`Is segment ${id} a skeleton key point?`, {
      true: 'A turning point, main-path hypothesis, or verification anchor.',
      false: 'Filler, or already covered by another key point.',
    })
    questions[`kind_${id}`] = choice(`Which skeleton kind fits segment ${id}?`, { ...KIND_CRITERIA })
  }
  return questions
}

export interface JevSparseLoopResult {
  last: SparseIntentStructured | undefined
  force_stopped: boolean
  rounds: number
  segments_read: string[]
  usage: TokenUsage
  notes: string[]
}

/**
 * Pool → sample → read_segment + mask → Jev questions → enough / gaps / skeleton.
 * Does not open a pi session and does not emit keep / collapse / drop.
 */
export async function runSparseIntentJev(input: SparseIntentInput): Promise<JevSparseLoopResult> {
  const maxRounds = input.max_rounds ?? SPARSE_INTENT_MAX_ROUNDS
  const maxSegments = input.max_segments_read ?? SPARSE_INTENT_MAX_SEGMENTS_READ
  const maxTokens = input.max_tokens ?? SPARSE_INTENT_MAX_TOKENS
  const sampleSize = input.round_sample_size ?? SPARSE_INTENT_ROUND_SAMPLE_SIZE
  const env = input.env ?? process.env
  const client = input.jevClient ?? createJevClient(env)

  const pool = buildCandidatePool({
    view: input.view,
    raw: input.raw,
    ...(input.head_turn_ids !== undefined ? { head_turn_ids: input.head_turn_ids } : {}),
    ...(input.verification_turn_ids !== undefined
      ? { verification_turn_ids: input.verification_turn_ids }
      : {}),
  })

  const readSet = new Set<string>()
  const segmentsRead: string[] = []
  const excerpts = new Map<string, string>()
  const notes: string[] = [
    client.kind === 'fake' ? HOLE_A_JEV_FAKE_NOTE : HOLE_A_JEV_LIVE_NOTE,
    INTENT_V0_TEMPLATE_NOTE,
  ]
  const points: SkeletonNode[] = []
  const cards = input.view.segments
  const openIds = new Set(cards.map((c) => c.id))
  const readCtx: HoleReadContext = { cards, raw: input.raw }
  let gaps: SparseGap[] | undefined
  let last: SparseIntentStructured | undefined
  let force_stopped = false
  let rounds = 0
  let usage: TokenUsage = {
    role: 'hole_a_skeleton',
    input_tokens: 0,
    output_tokens: 0,
  }

  for (let round = 0; round < maxRounds; round += 1) {
    throwIfAborted(input.signal)
    const spent = usage.input_tokens + usage.output_tokens
    if (spent >= maxTokens) {
      force_stopped = true
      notes.push('sparse_intent_token_budget')
      break
    }
    if (readSet.size >= maxSegments && last !== undefined) {
      force_stopped = true
      notes.push('sparse_intent_segment_budget')
      break
    }

    const batch = sampleCandidates(pool, {
      already_read: readSet,
      count: sampleSize,
      ...(gaps !== undefined ? { gaps } : {}),
      ...(input.rng !== undefined ? { rng: input.rng } : {}),
    })
    if (batch.length === 0) {
      force_stopped = true
      notes.push(readSet.size > 0 ? 'sparse_intent_pool_exhausted' : 'sparse_intent_empty_pool')
      break
    }

    rounds = round + 1
    let hitSegmentBudget = false
    for (const id of batch) {
      if (readSet.size >= maxSegments) {
        hitSegmentBudget = true
        notes.push('sparse_intent_segment_budget_mid_round')
        break
      }
      const read = readMasked(id, readCtx, openIds, readSet, segmentsRead, maxSegments)
      if (read.note !== undefined) notes.push(read.note)
      if (read.excerpt !== null) excerpts.set(id, read.excerpt)
    }

    const unreadIds = pool
      .map((entry) => entry.segment_id)
      .filter((id) => !readSet.has(id))
    const asked = batch.filter((id) => readSet.has(id))
    const state = buildJevSparseState({
      trace_id: input.trace_id,
      round: rounds,
      max_rounds: maxRounds,
      max_segments: maxSegments,
      tokens_used: usage.input_tokens + usage.output_tokens,
      pool,
      cards,
      readSet,
      excerpts,
      batchIds: asked,
      unreadIds,
      ...(gaps !== undefined ? { gaps } : {}),
    })

    let judged: SparseIntentStructured
    try {
      const result = await client.systemOne({
        state,
        questions: buildJevQuestions({ batchIds: asked, unreadIds }),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      })
      const apiIn = result.usage.input_tokens
      const estimated = estimateTokens(JSON.stringify(state))
      usage = {
        role: 'hole_a_skeleton',
        input_tokens: usage.input_tokens + (apiIn > 0 ? apiIn : estimated),
        output_tokens: usage.output_tokens + result.usage.output_tokens,
      }
      judged = applyJevRound({
        answers: result.answers,
        batchIds: asked,
        unreadIds,
        cards,
        pool,
        points,
      })
    } catch (error) {
      rethrowIfAborted(input.signal, error)
      const message = error instanceof Error ? error.message : String(error)
      notes.push(`sparse_intent_jev_round_${String(round)}_failed:${message}`)
      force_stopped = true
      break
    }

    last = judged
    gaps = judged.gaps
    if (judged.enough || hitSegmentBudget) {
      if (hitSegmentBudget) force_stopped = true
      break
    }
  }

  if (rounds >= maxRounds && (last === undefined || !last.enough)) {
    force_stopped = true
    notes.push('sparse_intent_max_rounds')
  }

  if (last === undefined) {
    last = {
      enough: false,
      intent_v0: intentTextFromTemplate('implement', points),
      scenario: 'implement',
      skeleton_points: [...points],
      uncertainty: UNCERTAINTY_WHEN_OPEN,
    }
  }

  return {
    last,
    force_stopped,
    rounds,
    segments_read: segmentsRead,
    usage,
    notes,
  }
}

export function buildJevSparseState(input: {
  trace_id: string
  round: number
  max_rounds: number
  max_segments: number
  tokens_used: number
  pool: readonly CandidateEntry[]
  cards: readonly SegmentCard[]
  readSet: ReadonlySet<string>
  excerpts: ReadonlyMap<string, string>
  batchIds: readonly string[]
  unreadIds: readonly string[]
  gaps?: readonly SparseGap[]
}): { [key: string]: JsonValue } {
  const byId = new Map(input.cards.map((card) => [card.id, card]))
  const cards: JsonValue[] = input.pool.map((entry) => {
    const card = byId.get(entry.segment_id)
    const excerpt = input.excerpts.get(entry.segment_id) ?? null
    return {
      id: entry.segment_id,
      stratum: entry.stratum,
      tool: card?.tool ?? '',
      outcome: card?.outcome ?? '',
      head: card?.head ?? '',
      read: input.readSet.has(entry.segment_id),
      excerpt,
    }
  })
  const prior_gaps: JsonValue[] = (input.gaps ?? []).map((gap) => {
    const rec: { [key: string]: JsonValue } = { hint: gap.hint }
    if (gap.segment_ids !== undefined) rec.segment_ids = [...gap.segment_ids]
    if (gap.strata !== undefined) rec.strata = [...gap.strata]
    if (typeof gap.weight === 'number') rec.weight = gap.weight
    return rec
  })
  return {
    trace_id: input.trace_id,
    round: input.round,
    max_rounds: input.max_rounds,
    max_segments_read: input.max_segments,
    segments_read: input.readSet.size,
    tokens_used: input.tokens_used,
    batch_ids: [...input.batchIds],
    unread_ids: [...input.unreadIds],
    prior_gaps,
    cards,
  }
}

function applyJevRound(input: {
  answers: Record<string, JevAnswer>
  batchIds: readonly string[]
  unreadIds: readonly string[]
  cards: readonly SegmentCard[]
  pool: readonly CandidateEntry[]
  points: SkeletonNode[]
}): SparseIntentStructured {
  const enough = noulOf(input.answers.enough) >= JEV_ENOUGH_NOUL_MIN
  const scenario = resolveSkillRoute(choiceOf(input.answers.scenario)).scenario
  const scored = scoreOf(input.answers.uncertainty)
  const uncertainty =
    scored === undefined
      ? enough
        ? UNCERTAINTY_WHEN_ENOUGH
        : UNCERTAINTY_WHEN_OPEN
      : uncertaintyFromScore(scored, JEV_UNCERTAINTY_LEVELS.length)

  const byId = new Map(input.cards.map((card) => [card.id, card]))
  const stratumOf = new Map(input.pool.map((entry) => [entry.segment_id, entry.stratum]))
  const have = new Set(input.points.map((point) => point.id))
  for (const id of input.batchIds) {
    if (noulOf(input.answers[`skel_${id}`]) < JEV_SKELETON_NOUL_MIN) continue
    const nodeId = `jev-${id}`
    if (have.has(nodeId)) continue
    const stratum = stratumOf.get(id) ?? 'random_fill'
    const chosen = choiceOf(input.answers[`kind_${id}`])
    const kind = isSkeletonNodeKind(chosen) ? chosen : kindFromStratum(stratum)
    input.points.push({
      id: nodeId,
      kind,
      segment_ids: [id],
      note: byId.get(id)?.head ?? '',
    })
    have.add(nodeId)
  }

  const out: SparseIntentStructured = {
    enough,
    intent_v0: intentTextFromTemplate(scenario, input.points),
    scenario,
    skeleton_points: [...input.points],
    uncertainty,
  }
  if (!enough) {
    const gaps = gapsFromAnswers(input.answers, input.unreadIds)
    if (gaps.length > 0) out.gaps = gaps
  }
  return out
}

function gapsFromAnswers(
  answers: Record<string, JevAnswer>,
  unreadIds: readonly string[],
): SparseGap[] {
  const gaps: SparseGap[] = []
  const gapId = choiceOf(answers.next_gap)
  if (gapId !== undefined && gapId !== 'none' && unreadIds.includes(gapId)) {
    gaps.push({ hint: 'jev: unread segment', segment_ids: [gapId] })
  }
  const stratum = choiceOf(answers.next_stratum)
  if (stratum !== undefined && stratum !== 'none' && isStratum(stratum)) {
    gaps.push({ hint: 'jev: stratum', strata: [stratum] })
  }
  if (gaps.length === 0 && unreadIds.length > 0) {
    gaps.push({
      hint: 'jev: unread batch',
      segment_ids: unreadIds.slice(0, SPARSE_INTENT_ROUND_SAMPLE_SIZE),
    })
  }
  return gaps
}

function readMasked(
  segmentId: string,
  readCtx: HoleReadContext,
  openIds: ReadonlySet<string>,
  readSet: Set<string>,
  segmentsRead: string[],
  maxSegments: number,
): { excerpt: string | null; note?: string } {
  if (readSet.size >= maxSegments) {
    return { excerpt: null, note: 'read_segment_budget' }
  }
  if (readSet.has(segmentId)) return { excerpt: null }
  const accepted = executeHoleTool('read_segment', { segment_id: segmentId }, { read: readCtx })
  if (!accepted.ok) {
    return { excerpt: null, note: `read_segment_rejected:${accepted.error}` }
  }
  if (accepted.name !== 'read_segment') {
    return { excerpt: null, note: 'read_segment_rejected:not read_segment' }
  }
  const read = accepted.accepted
  if (!openIds.has(read.segment_id)) {
    return { excerpt: null, note: 'read_segment_rejected:not_in_view' }
  }
  readSet.add(read.segment_id)
  segmentsRead.push(read.segment_id)
  const masked = maskToolResult(
    { segment_id: read.segment_id, focus: read.focus, text: read.text },
    { toolName: 'read_segment' },
  )
  const head = masked.structure.head
  const excerpt = typeof head === 'string' && head.length > 0 ? head : null
  return { excerpt }
}

function gapCriteria(ids: readonly string[]): { [label: string]: string } {
  const criteria: { [label: string]: string } = { none: 'No specific unread segment' }
  for (const id of ids) criteria[id] = `Unread segment ${id}`
  return criteria
}

function kindFromStratum(stratum: CandidateStratum): SkeletonNodeKind {
  if (stratum === 'verification') return 'verification_anchor'
  if (stratum === 'error_retry' || stratum === 'tool_failure_dense') return 'turning_point'
  return 'main_path_hypothesis'
}

function isSkeletonNodeKind(value: string | undefined): value is SkeletonNodeKind {
  return value !== undefined && (SKELETON_NODE_KINDS as readonly string[]).includes(value)
}

function isStratum(value: string): value is CandidateStratum {
  return (CANDIDATE_STRATA as readonly string[]).includes(value)
}

function noulOf(answer: JevAnswer | undefined): number {
  if (answer === undefined || answer.type !== 'noul') return 0
  return clamp01(answer.noul)
}

function choiceOf(answer: JevAnswer | undefined): string | undefined {
  if (answer === undefined || answer.type !== 'choice') return undefined
  return answer.choice
}

function scoreOf(answer: JevAnswer | undefined): number | undefined {
  if (answer === undefined || answer.type !== 'score') return undefined
  return answer.score
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
