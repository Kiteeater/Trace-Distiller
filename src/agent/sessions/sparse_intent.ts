/**
 * ADR-0011 洞 A：多轮稀疏采样 → 意图 / 场景 / 骨架关键点。
 * 不得发出 keep / collapse / drop；硬预算强制停机时仍给 best-effort + 高 uncertainty。
 */
import {
  SPARSE_INTENT_FORCE_STOP_UNCERTAINTY,
  SPARSE_INTENT_MAX_ROUNDS,
  SPARSE_INTENT_MAX_SEGMENTS_READ,
  SPARSE_INTENT_MAX_TOKENS,
  SPARSE_INTENT_ROUND_SAMPLE_SIZE,
  SKELETON_PASS_TOKEN_HINT,
} from '../../constant/window.ts'
import { resolveSkillRoute } from '../../constant/skill_route.ts'
import type { Scenario } from '../../enums/scenario.ts'
import type {
  AgentView,
  IntentHypothesis,
  Skeleton,
  SkeletonNode,
  SkeletonNodeKind,
} from '../../types/agent_view.ts'
import type { RawTrace, TraceId } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'
import { HOLE_A_TOOL_NAMES, handleReadSegment, type HoleReadContext } from '../extension.ts'
import {
  buildCandidatePool,
  sampleCandidates,
  type CandidateEntry,
  type SparseGap,
} from './candidate_pool.ts'
import { TRACE_DATA_NOTICE, cardIndexPayload } from './card_index.ts'
import {
  openSession,
  parseStructuredJson,
  type SessionBackend,
  type SessionMessage,
  type SessionPromptResult,
  type SessionToolCall,
} from './open_session.ts'
import { formatMaskedForPrompt, maskToolResult } from './tool_mask.ts'
import { estimateTokens } from '../../utils/tokens.ts'
import type { TokenUsage } from './skeleton_pass.ts'

const SKELETON_NODE_KINDS: readonly SkeletonNodeKind[] = [
  'turning_point',
  'main_path_hypothesis',
  'verification_anchor',
]

function isSkeletonNodeKind(value: unknown): value is SkeletonNodeKind {
  return typeof value === 'string' && (SKELETON_NODE_KINDS as readonly string[]).includes(value)
}


/** 洞 A 仅允许读段；禁止 keep/label 等裁剪工具。 */
export const HOLE_A_SPARSE_TOOL_NAMES = HOLE_A_TOOL_NAMES

export const SPARSE_INTENT_JSON_KIND = 'sparse_intent_v0' as const

export interface SparseIntentInput {
  trace_id: TraceId
  head_turn_ids?: string[]
  verification_turn_ids?: string[]
  raw: RawTrace
  view: AgentView
  backend?: SessionBackend
  max_rounds?: number
  max_segments_read?: number
  max_tokens?: number
  round_sample_size?: number
  /** 测试注入 RNG。 */
  rng?: () => number
}

export interface SparseIntentStructured {
  enough: boolean
  intent_v0: string
  scenario: Scenario
  skeleton_points: SkeletonNode[]
  uncertainty: number
  gaps?: SparseGap[]
}

export interface SparseIntentOutput {
  enough: boolean
  intent: IntentHypothesis
  scenario: Scenario
  skeleton: Skeleton
  skeleton_points: SkeletonNode[]
  uncertainty: number
  gaps?: SparseGap[]
  force_stopped: boolean
  rounds: number
  segments_read: string[]
  usage: TokenUsage
  notes?: string[]
}

const CUT_ACTION_KEYS = ['keep', 'collapse', 'drop', 'cut_action', 'action'] as const

/**
 * 洞 A 主路径：分层池 → 多轮采样/读段/判断 → 骨架关键点。
 */
export async function sparseIntent(input: SparseIntentInput): Promise<SparseIntentOutput> {
  const maxRounds = input.max_rounds ?? SPARSE_INTENT_MAX_ROUNDS
  const maxSegments = input.max_segments_read ?? SPARSE_INTENT_MAX_SEGMENTS_READ
  const maxTokens = input.max_tokens ?? SPARSE_INTENT_MAX_TOKENS
  const sampleSize = input.round_sample_size ?? SPARSE_INTENT_ROUND_SAMPLE_SIZE

  const pool = buildCandidatePool({
    view: input.view,
    raw: input.raw,
    ...(input.head_turn_ids !== undefined ? { head_turn_ids: input.head_turn_ids } : {}),
    ...(input.verification_turn_ids !== undefined
      ? { verification_turn_ids: input.verification_turn_ids }
      : {}),
  })

  const session = openSession({
    role: 'hole_a_skeleton',
    tools: HOLE_A_SPARSE_TOOL_NAMES,
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
  })

  const readSet = new Set<string>()
  const segmentsRead: string[] = []
  const notes: string[] = []
  const messages: SessionMessage[] = []
  let gaps: SparseGap[] | undefined
  let last: SparseIntentStructured | undefined
  let force_stopped = false
  let rounds = 0
  let usage: TokenUsage = {
    role: session.role,
    input_tokens: 0,
    output_tokens: 0,
  }

  const cards = input.view.segments
  const openIds = new Set(cards.map((c) => c.id))
  const readCtx: HoleReadContext = { cards, raw: input.raw }

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      if (usage.input_tokens + usage.output_tokens >= maxTokens) {
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
      // 若池已读完仍不够，也强制停
      if (batch.length === 0 && readSet.size > 0) {
        force_stopped = true
        notes.push('sparse_intent_pool_exhausted')
        break
      }

      rounds = round + 1
      let result: SessionPromptResult
      try {
        result = await session.prompt({
          system: composeSparseSystem(),
          messages,
          text: composeSparseRoundText({
            trace_id: input.trace_id,
            pool,
            batch,
            cards,
            gaps,
            round,
            read_ids: [...readSet],
            max_rounds: maxRounds,
            max_segments: maxSegments,
            max_tokens: maxTokens,
            tokens_used: usage.input_tokens + usage.output_tokens,
          }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`sparse_intent_round_${String(round)}_failed:${message}`)
        force_stopped = true
        break
      }

      usage = addUsage(usage, result.usage)

      // Inner: allow a few read_segment tool turns before requiring JSON.
      let inner = 0
      while (result.tool_calls.length > 0 && inner < 4) {
        if (readSet.size >= maxSegments) {
          force_stopped = true
          notes.push('sparse_intent_segment_budget_mid_round')
          break
        }
        if (usage.input_tokens + usage.output_tokens >= maxTokens) {
          force_stopped = true
          notes.push('sparse_intent_token_budget_mid_round')
          break
        }

        const banned = result.tool_calls.filter((c) => c.name !== 'read_segment')
        for (const b of banned) {
          notes.push(`sparse_intent_banned_tool:${b.name}`)
        }

        const maskedLines: string[] = []
        for (const call of result.tool_calls) {
          if (call.name !== 'read_segment') {
            maskedLines.push(
              formatMaskedForPrompt(
                maskToolResult({ ignored: call.name, error: 'hole_a_read_segment_only' }, {
                  toolName: call.name,
                }),
              ),
            )
            continue
          }
          const handled = interpretRead(call, readCtx, openIds, readSet, segmentsRead, maxSegments)
          if (handled.note !== undefined) notes.push(handled.note)
          maskedLines.push(
            formatMaskedForPrompt(maskToolResult(handled.maskPayload, { toolName: 'read_segment' })),
          )
        }

        messages.push({
          role: 'assistant',
          content: `tool_calls: ${result.tool_calls.map((c) => c.name).join(', ')}`,
        })
        messages.push({
          role: 'user',
          content: [
            'MASKED_TOOL_RESULTS (ADR-0010/0011; full payloads not re-injected):',
            ...maskedLines,
            'Continue: if context is enough, emit sparse_intent_v0 JSON; else emit enough=false with gaps.',
            'Never emit keep/collapse/drop.',
          ].join('\n'),
        })

        try {
          result = await session.prompt({
            system: composeSparseSystem(),
            messages,
            text: 'Judge now. Reply with sparse_intent_v0 JSON only, or call read_segment for unread batch ids.',
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          notes.push(`sparse_intent_inner_${String(round)}_failed:${message}`)
          force_stopped = true
          break
        }
        usage = addUsage(usage, result.usage)
        inner += 1
      }

      if (force_stopped && last === undefined && result.tool_calls.length > 0) {
        // try parse anyway if text present
      }

      const payload = result.json ?? tryParseJson(result.text)
      if (payload !== null && payload !== undefined) {
        try {
          last = parseSparseIntentJson(payload)
          gaps = last.gaps
          if (last.enough) break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          notes.push(`sparse_intent_parse_${String(round)}:${message}`)
        }
      } else if (result.tool_calls.length === 0) {
        notes.push(`sparse_intent_round_${String(round)}_no_json`)
      }

      // Mark batch as "offered" even if not read — avoid infinite same sample.
      // Actually we should NOT mark unread as read; sampleCandidates already prefers unread.
      // If agent didn't read and said not enough without gaps, force mild gaps toward unread batch.
      if (last !== undefined && !last.enough && (last.gaps === undefined || last.gaps.length === 0)) {
        gaps = [{ hint: 'auto: unread batch', segment_ids: batch.filter((id) => !readSet.has(id)) }]
      }
    }

    if (rounds >= maxRounds && (last === undefined || !last.enough)) {
      force_stopped = true
      notes.push('sparse_intent_max_rounds')
    }
  } finally {
    session.dispose()
  }

  return finalizeSparseOutput({
    last,
    force_stopped,
    rounds,
    segmentsRead,
    usage,
    notes,
  })
}

export function composeSparseSystem(): string {
  return [
    'You are Hole A sparse intent sampler (ADR-0011).',
    'Multi-round sparse sampling on segment cards. Infer intent_v0, scenario, and skeleton key points only.',
    'Call read_segment when CARD_INDEX heads are not enough; results are masked.',
    'Never emit keep, collapse, drop, or any cut decision.',
    'When context is enough set enough=true and omit gaps; otherwise enough=false and provide structured gaps.',
    TRACE_DATA_NOTICE,
  ].join(' ')
}

export function composeSparseRoundText(input: {
  trace_id: string
  pool: readonly CandidateEntry[]
  batch: readonly string[]
  cards: readonly SegmentCard[]
  gaps: readonly SparseGap[] | undefined
  round: number
  read_ids: readonly string[]
  max_rounds: number
  max_segments: number
  max_tokens: number
  tokens_used: number
}): string {
  const batchCards = input.cards.filter((c) => input.batch.includes(c.id))
  const stratumSummary = summarizePool(input.pool)
  return [
    `trace_id: ${input.trace_id}`,
    `round: ${String(input.round)}`,
    `token_budget_hint: ${String(SKELETON_PASS_TOKEN_HINT)}`,
    `hard_budget: max_rounds=${String(input.max_rounds)} max_segments_read=${String(input.max_segments)} max_tokens=${String(input.max_tokens)} tokens_used≈${String(input.tokens_used)}`,
    `already_read_segment_ids: ${JSON.stringify(input.read_ids)}`,
    `candidate_pool_strata: ${JSON.stringify(stratumSummary)}`,
    `sample_batch_segment_ids: ${JSON.stringify(input.batch)}`,
    input.gaps !== undefined && input.gaps.length > 0
      ? `prior_gaps: ${JSON.stringify(input.gaps)}`
      : 'prior_gaps: []',
    `CARD_INDEX (compact; upgrade via read_segment):\n${cardIndexPayload(input.cards)}`,
    `BATCH_CARDS:\n${cardIndexPayload(batchCards)}`,
    [
      'Reply with JSON only matching:',
      JSON.stringify({
        kind: SPARSE_INTENT_JSON_KIND,
        enough: true,
        intent_v0: 'string',
        scenario: 'debug|implement|refactor|test_fix|investigate',
        skeleton_points: [
          {
            id: 'string',
            kind: SKELETON_NODE_KINDS.join('|'),
            segment_ids: ['string'],
            note: 'string',
          },
        ],
        uncertainty: 0.0,
        gaps: [{ hint: 'string', segment_ids: ['string'], strata: ['error_retry'] }],
      }),
      'If not enough, set enough=false and fill gaps (no keep/collapse/drop fields).',
    ].join('\n'),
  ].join('\n\n')
}

export function parseSparseIntentJson(value: unknown): SparseIntentStructured {
  const rec = asRecord(value)
  if (rec === undefined) throw new Error('sparseIntent: expected a JSON object')
  assertNoCutActions(rec)

  // Accept legacy skeleton_pass_v0 as enough=true one-shot.
  if (rec.kind === 'skeleton_pass_v0') {
    const intent_text = readIntentText(rec.intent ?? rec.intent_text ?? rec.intent_v0)
    if (intent_text.length === 0) throw new Error('sparseIntent: intent text is required')
    const nodes = parseSkeletonPoints(asRecord(rec.skeleton)?.nodes ?? rec.nodes ?? rec.skeleton_points)
    const scenario = resolveSkillRoute(rec.scenario).scenario
    return {
      enough: true,
      intent_v0: intent_text,
      scenario,
      skeleton_points: nodes,
      uncertainty: 0.35,
    }
  }

  const intent_text = readIntentText(rec.intent_v0 ?? rec.intent ?? rec.intent_text)
  if (intent_text.length === 0) throw new Error('sparseIntent: intent_v0 is required')
  const scenario = resolveSkillRoute(rec.scenario).scenario
  const points = parseSkeletonPoints(rec.skeleton_points ?? asRecord(rec.skeleton)?.nodes)
  const enough = rec.enough === true
  let uncertainty = typeof rec.uncertainty === 'number' && Number.isFinite(rec.uncertainty)
    ? clamp01(rec.uncertainty)
    : enough
      ? 0.3
      : 0.6
  const gaps = parseGaps(rec.gaps)
  const out: SparseIntentStructured = {
    enough,
    intent_v0: intent_text,
    scenario,
    skeleton_points: points,
    uncertainty,
  }
  if (gaps !== undefined) out.gaps = gaps
  return out
}

export function assertNoCutActions(rec: Record<string, unknown>): void {
  for (const key of CUT_ACTION_KEYS) {
    if (key in rec && key !== 'action') {
      // allow nested note text; ban top-level cut fields and arrays of cut decisions
      if (key === 'keep' || key === 'collapse' || key === 'drop' || key === 'cut_action') {
        throw new Error(`sparseIntent: Hole A must not emit cut field '${key}'`)
      }
    }
  }
  if (Array.isArray(rec.decisions) || Array.isArray(rec.cut_plan) || Array.isArray(rec.labels)) {
    throw new Error('sparseIntent: Hole A must not emit cut decisions/labels')
  }
  // skeleton_points / nodes must not carry action keep|collapse|drop
  const nodes = rec.skeleton_points ?? asRecord(rec.skeleton)?.nodes ?? rec.nodes
  if (Array.isArray(nodes)) {
    for (const item of nodes) {
      const n = asRecord(item)
      if (n === undefined) continue
      const action = n.action ?? n.cut_action
      if (action === 'keep' || action === 'collapse' || action === 'drop') {
        throw new Error('sparseIntent: skeleton_points must not include keep/collapse/drop')
      }
    }
  }
}

function finalizeSparseOutput(input: {
  last: SparseIntentStructured | undefined
  force_stopped: boolean
  rounds: number
  segmentsRead: string[]
  usage: TokenUsage
  notes: string[]
}): SparseIntentOutput {
  const force = input.force_stopped || input.last === undefined || !input.last.enough
  const intentText = input.last?.intent_v0 ?? 'uncertain intent (sparse sampling force-stopped)'
  const scenario = input.last?.scenario ?? 'implement'
  let uncertainty = input.last?.uncertainty ?? SPARSE_INTENT_FORCE_STOP_UNCERTAINTY
  if (force) uncertainty = Math.max(uncertainty, SPARSE_INTENT_FORCE_STOP_UNCERTAINTY)
  const points = input.last?.skeleton_points ?? []
  const enough = input.last?.enough === true && !input.force_stopped
  const out: SparseIntentOutput = {
    enough,
    intent: { version: 0, text: intentText, scenario },
    scenario,
    skeleton: { version: 0, nodes: points },
    skeleton_points: points,
    uncertainty,
    force_stopped: force && !enough,
    rounds: input.rounds,
    segments_read: input.segmentsRead,
    usage: input.usage,
  }
  if (input.last?.gaps !== undefined) out.gaps = input.last.gaps
  if (input.notes.length > 0) out.notes = input.notes
  // If agent said enough but we also hit a soft note only — keep enough.
  if (input.last?.enough === true && !input.force_stopped) {
    out.enough = true
    out.force_stopped = false
  }
  return out
}

function interpretRead(
  call: SessionToolCall,
  readCtx: HoleReadContext,
  openIds: ReadonlySet<string>,
  readSet: Set<string>,
  segmentsRead: string[],
  maxSegments: number,
): { maskPayload: unknown; note?: string } {
  if (readSet.size >= maxSegments) {
    return {
      maskPayload: { segment_id: null, focus: 'full', text: '', error: 'segment budget exhausted' },
      note: 'read_segment_budget',
    }
  }
  const accepted = handleReadSegment(readCtx, call.arguments)
  if (!accepted.ok) {
    return {
      maskPayload: { segment_id: null, focus: 'full', text: '', error: accepted.error },
      note: `read_segment_rejected:${accepted.error}`,
    }
  }
  if (!openIds.has(accepted.segment_id)) {
    return {
      maskPayload: { segment_id: accepted.segment_id, focus: 'full', text: '', error: 'not in view' },
      note: `read_segment_rejected:not_in_view`,
    }
  }
  if (!readSet.has(accepted.segment_id)) {
    readSet.add(accepted.segment_id)
    segmentsRead.push(accepted.segment_id)
  }
  // Mask path: do not put full text into maskPayload for prompt; maskToolResult will head-truncate.
  // Still pass text so mask can report text_chars/head; full may go store later (out of scope).
  return {
    maskPayload: {
      segment_id: accepted.segment_id,
      focus: accepted.focus,
      text: accepted.text,
    },
  }
}

function summarizePool(pool: readonly CandidateEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of pool) {
    out[e.stratum] = (out[e.stratum] ?? 0) + 1
  }
  return out
}

function parseSkeletonPoints(value: unknown): SkeletonNode[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('sparseIntent: skeleton_points must be an array')
  const nodes: SkeletonNode[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (rec === undefined) throw new Error('sparseIntent: skeleton point must be an object')
    assertNoCutActions(rec)
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
      throw new Error('sparseIntent: skeleton point id is required')
    }
    if (!isSkeletonNodeKind(rec.kind)) {
      throw new Error('sparseIntent: skeleton point kind is invalid')
    }
    if (!Array.isArray(rec.segment_ids) || rec.segment_ids.some((id) => typeof id !== 'string')) {
      throw new Error('sparseIntent: skeleton point segment_ids must be string[]')
    }
    const note = typeof rec.note === 'string' ? rec.note : ''
    nodes.push({
      id: rec.id,
      kind: rec.kind as SkeletonNodeKind,
      segment_ids: rec.segment_ids as string[],
      note,
    })
  }
  return nodes
}

function parseGaps(value: unknown): SparseGap[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('sparseIntent: gaps must be an array')
  const gaps: SparseGap[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (rec === undefined) throw new Error('sparseIntent: gap must be an object')
    const hint = typeof rec.hint === 'string' ? rec.hint : typeof rec.reason === 'string' ? rec.reason : ''
    if (hint.length === 0) throw new Error('sparseIntent: gap hint is required')
    const gap: SparseGap = { hint }
    if (Array.isArray(rec.segment_ids)) {
      gap.segment_ids = rec.segment_ids.filter((id): id is string => typeof id === 'string')
    }
    if (Array.isArray(rec.strata)) {
      const strata = rec.strata.filter((s): s is string => typeof s === 'string')
      if (strata.length > 0) gap.strata = strata as NonNullable<SparseGap['strata']>
    }
    if (typeof rec.weight === 'number' && Number.isFinite(rec.weight)) gap.weight = rec.weight
    gaps.push(gap)
  }
  return gaps
}

function readIntentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const rec = asRecord(value)
  if (rec !== undefined && typeof rec.text === 'string') return rec.text.trim()
  return ''
}

function tryParseJson(text: string): unknown | null {
  if (text.trim().length === 0) return null
  try {
    return parseStructuredJson(text)
  } catch {
    return null
  }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    role: a.role,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Test helper: estimate prompt size without a session. */
export function estimateSparseRoundTokens(text: string): number {
  return estimateTokens(text)
}
