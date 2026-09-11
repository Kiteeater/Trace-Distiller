import {
  SKELETON_PASS_TOKEN_HINT,
  SKELETON_TURN_CONTENT_MAX_CHARS,
} from '../../constant/window.ts'
import { resolveSkillRoute } from '../../constant/skill_route.ts'
import type { AgentRole } from '../../enums/agent_role.ts'
import { type Scenario } from '../../enums/scenario.ts'
import type {
  AgentView,
  IntentHypothesis,
  Skeleton,
  SkeletonNode,
  SkeletonNodeKind,
} from '../../types/agent_view.ts'
import type { RawTrace, RawTurn, TraceId } from '../../types/raw_trace.ts'
import {
  openQaSession,
  openReplaySession,
  openReviewSession,
  openSession,
  parseStructuredJson,
  type SessionBackend,
  type SessionPromptResult,
} from './open_session.ts'
import { TRACE_DATA_NOTICE, cardIndexEntry, cardIndexPayload } from './card_index.ts'
import { sparseIntent, type SparseIntentOutput } from './sparse_intent.ts'

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

export interface TokenUsage {
  role: AgentRole
  input_tokens: number
  output_tokens: number
}

export type {
  PiSessionHandle,
  SessionBackend,
  SessionFactoryOpts,
} from './open_session.ts'

export {
  hasInjectedSessionBackend,
  holeModelsConfigured,
  openQaSession,
  openReplaySession,
  openReviewSession,
  openSession,
} from './open_session.ts'

export { TRACE_DATA_NOTICE, cardIndexEntry, cardIndexPayload } from './card_index.ts'

/** @deprecated Prefer sparse_intent_v0 (ADR-0011). Still accepted by parsers / FakeSessionBackend. */
export const SKELETON_PASS_JSON_KIND = 'skeleton_pass_v0' as const

export const SKELETON_NODE_KINDS: readonly SkeletonNodeKind[] = [
  'turning_point',
  'main_path_hypothesis',
  'verification_anchor',
]

export interface SkeletonPassJson {
  kind: typeof SKELETON_PASS_JSON_KIND
  intent: { text: string }
  scenario: Scenario
  skeleton: { nodes: SkeletonNode[] }
}

export interface SkeletonPassInput {
  trace_id: TraceId
  /** adapter 标出的锚点；候选池分层用 */
  head_turn_ids: string[]
  verification_turn_ids: string[]
  raw: RawTrace
  view: AgentView
  /** 测试注入；生产省略，走 openSession 默认后端。 */
  backend?: SessionBackend
  max_rounds?: number
  max_segments_read?: number
  max_tokens?: number
  round_sample_size?: number
  rng?: () => number
}

export interface SkeletonPassOutput {
  intent: IntentHypothesis
  scenario: Scenario
  skeleton: Skeleton
  usage: TokenUsage
  /** ADR-0011 结构化审计字段 */
  enough: boolean
  uncertainty: number
  force_stopped: boolean
  rounds: number
  segments_read: string[]
  gaps?: SparseIntentOutput['gaps']
  notes?: string[]
}

/**
 * 洞 A（ADR-0011）：多轮稀疏采样 → intent / scenario / skeleton key points。
 * 禁止注入 raw.turns 全量；经 read_segment + tool mask；不得发出 keep/collapse/drop。
 * 会话只经 open_session.ts。模型：TRACE_DISTILLER_MODEL_HOLE_A。
 */
export async function skeletonPass(input: SkeletonPassInput): Promise<SkeletonPassOutput> {
  const sparse = await sparseIntent({
    trace_id: input.trace_id,
    head_turn_ids: input.head_turn_ids,
    verification_turn_ids: input.verification_turn_ids,
    raw: input.raw,
    view: input.view,
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
    ...(input.max_rounds !== undefined ? { max_rounds: input.max_rounds } : {}),
    ...(input.max_segments_read !== undefined
      ? { max_segments_read: input.max_segments_read }
      : {}),
    ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
    ...(input.round_sample_size !== undefined
      ? { round_sample_size: input.round_sample_size }
      : {}),
    ...(input.rng !== undefined ? { rng: input.rng } : {}),
  })
  const out: SkeletonPassOutput = {
    intent: sparse.intent,
    scenario: sparse.scenario,
    skeleton: sparse.skeleton,
    usage: sparse.usage,
    enough: sparse.enough,
    uncertainty: sparse.uncertainty,
    force_stopped: sparse.force_stopped,
    rounds: sparse.rounds,
    segments_read: sparse.segments_read,
  }
  if (sparse.gaps !== undefined) out.gaps = sparse.gaps
  if (sparse.notes !== undefined) out.notes = sparse.notes
  return out
}

/** @deprecated 旧固定头尾一枪可见集；测试兼容保留。 */
export function selectVisibleTurns(input: SkeletonPassInput): {
  head: RawTurn[]
  verification: RawTurn[]
} {
  const byId = new Map(input.raw.turns.map((t) => [t.id, t]))
  return {
    head: pickTurns(byId, input.head_turn_ids),
    verification: pickTurns(byId, input.verification_turn_ids),
  }
}

/** @deprecated 旧一枪 prompt；测试兼容保留。新路径见 composeSparseRoundText。 */
export function composeSkeletonPassPrompt(
  input: SkeletonPassInput,
  visible: { head: RawTurn[]; verification: RawTurn[] },
): {
  system: string
  text: string
} {
  const cardsJson = cardIndexPayload(input.view.segments)
  const text = [
    TRACE_DATA_NOTICE,
    `trace_id: ${input.trace_id}`,
    `token_budget_hint: ${String(SKELETON_PASS_TOKEN_HINT)}`,
    formatTurnBlock('HEAD_TURNS', visible.head),
    formatTurnBlock('VERIFICATION_TURNS', visible.verification),
    `CARD_INDEX (ids + short heads; do not invent fields; upgrade via tools later):\n${cardsJson}`,
    [
      'Reply with JSON only, matching this schema:',
      JSON.stringify({
        kind: SKELETON_PASS_JSON_KIND,
        intent: { text: 'string' },
        scenario: 'debug|implement|refactor|test_fix|investigate',
        skeleton: {
          nodes: [
            {
              id: 'string',
              kind: SKELETON_NODE_KINDS.join('|'),
              segment_ids: ['string'],
              note: 'string',
            },
          ],
        },
      }),
    ].join('\n'),
  ].join('\n\n')
  return {
    system: 'You infer intent v0, a Scenario code, and skeleton v0. Output structured JSON only.',
    text,
  }
}

export function interpretSkeletonPassResult(
  result: SessionPromptResult,
  role: AgentRole,
): SkeletonPassOutput {
  const payload = result.json ?? tryParseJson(result.text)
  const parsed = parseSkeletonPassJson(payload)
  const scenario = resolveSkillRoute(parsed.scenario).scenario
  return {
    intent: { version: 0, text: parsed.intent_text, scenario },
    scenario,
    skeleton: { version: 0, nodes: parsed.nodes },
    usage: {
      role,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
    enough: true,
    uncertainty: 0.35,
    force_stopped: false,
    rounds: 1,
    segments_read: [],
  }
}

export function parseSkeletonPassJson(value: unknown): {
  intent_text: string
  scenario: unknown
  nodes: SkeletonNode[]
} {
  const rec = asRecord(value)
  if (rec === undefined) {
    throw new Error('skeletonPass: expected a JSON object')
  }
  const intent_text = readIntentText(rec.intent ?? rec.intent_text ?? rec.intent_v0)
  if (intent_text.length === 0) {
    throw new Error('skeletonPass: intent text is required')
  }
  const skeleton = rec.skeleton
  const nodesRaw = Array.isArray(rec.skeleton_points)
    ? rec.skeleton_points
    : Array.isArray(rec.nodes)
      ? rec.nodes
      : asRecord(skeleton)?.nodes
  const nodes = parseSkeletonNodes(nodesRaw)
  return { intent_text, scenario: rec.scenario, nodes }
}

export function isSkeletonNodeKind(value: unknown): value is SkeletonNodeKind {
  return typeof value === 'string' && (SKELETON_NODE_KINDS as readonly string[]).includes(value)
}

function parseSkeletonNodes(value: unknown): SkeletonNode[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error('skeletonPass: skeleton.nodes must be an array')
  }
  const nodes: SkeletonNode[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (rec === undefined) throw new Error('skeletonPass: skeleton node must be an object')
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
      throw new Error('skeletonPass: skeleton node id is required')
    }
    if (!isSkeletonNodeKind(rec.kind)) {
      throw new Error('skeletonPass: skeleton node kind is invalid')
    }
    if (!Array.isArray(rec.segment_ids) || rec.segment_ids.some((id) => typeof id !== 'string')) {
      throw new Error('skeletonPass: skeleton node segment_ids must be string[]')
    }
    const note = typeof rec.note === 'string' ? rec.note : ''
    nodes.push({
      id: rec.id,
      kind: rec.kind,
      segment_ids: rec.segment_ids as string[],
      note,
    })
  }
  return nodes
}

function readIntentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const rec = asRecord(value)
  if (rec !== undefined && typeof rec.text === 'string') return rec.text.trim()
  return ''
}

function tryParseJson(text: string): unknown {
  try {
    return parseStructuredJson(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON'
    throw new Error(`skeletonPass: failed to parse structured JSON (${message})`)
  }
}

function pickTurns(byId: Map<string, RawTurn>, ids: readonly string[]): RawTurn[] {
  const out: RawTurn[] = []
  for (const id of ids) {
    const turn = byId.get(id)
    if (turn !== undefined) out.push(turn)
  }
  return out
}

function formatTurnBlock(title: string, turns: readonly RawTurn[]): string {
  if (turns.length === 0) return `${title}: (none)`
  const body = turns
    .map((t) => `[${t.id}] ${t.role}\n${truncateTurnContent(t.content)}`)
    .join('\n\n')
  return `${title}:\n${body}`
}

function truncateTurnContent(content: string): string {
  if (content.length <= SKELETON_TURN_CONTENT_MAX_CHARS) return content
  return `${content.slice(0, SKELETON_TURN_CONTENT_MAX_CHARS)}…`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

