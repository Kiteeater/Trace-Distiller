/**
 * TypeSafe Jev client for Hole A decisions (ADR-0017).
 * Live calls POST https://api.typesafe.ai/v1/systemone via @typesafe-ai/sdk.
 * No API key → FakeJevClient (no network). Keys are never logged.
 */
import {
  TypeSafeClient,
  type EntryType,
  type Fetch,
  type Question,
  type Questions,
} from '@typesafe-ai/sdk'
import {
  JEV_ENOUGH_NOUL_MIN,
  SESSION_CALL_TIMEOUT_MS,
  SESSION_TIMEOUT_ENV,
} from '../../constant/window.ts'
import { resolveTimeoutMs } from '../../utils/timeout.ts'

export const HOLE_A_DECISION_ENV = 'TRACE_DISTILLER_HOLE_A_DECISION'
export const JEV_API_KEY_ENV = 'TRACE_DISTILLER_JEV_API_KEY'
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY'
export const JEV_MODEL_ENV = 'TRACE_DISTILLER_JEV_MODEL'
export const JEV_MODEL_DEFAULT = 'jev-latest'
export const JEV_API_BASE = 'https://api.typesafe.ai'

export type HoleADecisionBackend = 'jev' | 'pi'

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number }
  | { type: 'score'; score: number; confidence: number }

export interface JevCallResult {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export interface JevSystemOneInput {
  state: EntryType
  questions: Questions
  signal?: AbortSignal
}

export interface JevClient {
  readonly kind: 'fake' | 'typesafe'
  systemOne(input: JevSystemOneInput): Promise<JevCallResult>
}

export interface ResolveHoleADecisionInput {
  decision?: HoleADecisionBackend
  hasJevClient?: boolean
  hasSessionBackend?: boolean
  env?: NodeJS.Dict<string>
}

/**
 * 1. explicit `decision`
 * 2. TRACE_DISTILLER_HOLE_A_DECISION=jev|pi
 * 3. injected Jev client
 * 4. injected SessionBackend (argument or setSessionBackend / --fake-l4) → pi
 * 5. jev
 */
export function resolveHoleADecision(input: ResolveHoleADecisionInput = {}): HoleADecisionBackend {
  if (input.decision === 'jev' || input.decision === 'pi') return input.decision
  const env = input.env ?? process.env
  const raw = readEnv(env, HOLE_A_DECISION_ENV).toLowerCase()
  if (raw === 'jev' || raw === 'pi') return raw
  if (input.hasJevClient === true) return 'jev'
  if (input.hasSessionBackend === true) return 'pi'
  return 'jev'
}

/** TRACE_DISTILLER_JEV_API_KEY overrides TYPESAFE_API_KEY. Blank is missing. */
export function readJevApiKey(env: NodeJS.Dict<string> = process.env): string | undefined {
  const alias = readEnv(env, JEV_API_KEY_ENV)
  if (alias.length > 0) return alias
  const primary = readEnv(env, TYPESAFE_API_KEY_ENV)
  if (primary.length > 0) return primary
  return undefined
}

export function readJevModel(env: NodeJS.Dict<string> = process.env): string {
  const model = readEnv(env, JEV_MODEL_ENV)
  return model.length > 0 ? model : JEV_MODEL_DEFAULT
}

export interface CreateJevClientOpts {
  fetch?: Fetch
}

/** Live TypeSafe client when a key is set; otherwise FakeJevClient. */
export function createJevClient(
  env: NodeJS.Dict<string> = process.env,
  opts: CreateJevClientOpts = {},
): JevClient {
  const apiKey = readJevApiKey(env)
  if (apiKey === undefined) return new FakeJevClient()
  return new TypeSafeJevClient({
    apiKey,
    model: readJevModel(env),
    timeoutMs: resolveTimeoutMs(env[SESSION_TIMEOUT_ENV], SESSION_CALL_TIMEOUT_MS),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  })
}

/**
 * Deterministic Hole A answers from the compact sparse state.
 * No HTTP. Used by tests, CI, and jev mode without an API key.
 */
export class FakeJevClient implements JevClient {
  readonly kind = 'fake' as const
  readonly calls: JevSystemOneInput[] = []

  systemOne(input: JevSystemOneInput): Promise<JevCallResult> {
    this.calls.push(input)
    const state = parseFakeState(input.state)
    const answers: Record<string, JevAnswer> = {}
    for (const [name, question] of Object.entries(input.questions)) {
      answers[name] = answerFake(name, question, state)
    }
    return Promise.resolve({
      model: 'jev-fake',
      answers,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  }
}

export class TypeSafeJevClient implements JevClient {
  readonly kind = 'typesafe' as const
  private readonly client: TypeSafeClient
  private readonly model: string

  constructor(opts: { apiKey: string; model: string; timeoutMs: number; fetch?: Fetch }) {
    this.model = opts.model
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      baseURL: JEV_API_BASE,
      defaultModel: opts.model,
      logLevel: 'off',
      timeout: opts.timeoutMs,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    })
  }

  async systemOne(input: JevSystemOneInput): Promise<JevCallResult> {
    const result = await this.client.systemOne(
      { state: input.state, questions: input.questions, model: this.model },
      input.signal !== undefined ? { signal: input.signal } : {},
    )
    return {
      model: typeof result.model === 'string' ? result.model : this.model,
      answers: normalizeAnswers(result.answers),
      usage: readUsage(result.usage),
    }
  }
}

interface FakeCard {
  id: string
  stratum: string
  head: string
  read: boolean
  excerpt: string
}

interface FakeState {
  cards: FakeCard[]
  unread_ids: string[]
}

const ANCHOR_STRATA = ['head', 'verification', 'error_retry', 'tool_failure_dense'] as const

function answerFake(name: string, question: Question, state: FakeState): JevAnswer {
  if (question.type === 'noul') {
    if (name === 'enough') return { type: 'noul', noul: fakeEnough(state) }
    if (name.startsWith('skel_')) return { type: 'noul', noul: fakeSkel(state, name.slice('skel_'.length)) }
    return { type: 'noul', noul: 0 }
  }
  if (question.type === 'score') {
    const idx = fakeEnough(state) >= JEV_ENOUGH_NOUL_MIN ? 1 : 3
    return { type: 'score', score: idx, confidence: 0.9 }
  }
  const labels = Object.keys(question.criteria)
  if (name === 'scenario') {
    return { type: 'choice', choice: fakeScenario(state, labels), confidence: 0.8 }
  }
  if (name === 'next_stratum') {
    return { type: 'choice', choice: fakeStratum(state, labels), confidence: 0.8 }
  }
  if (name === 'next_gap') {
    return { type: 'choice', choice: fakeGap(state, labels), confidence: 0.8 }
  }
  if (name.startsWith('kind_')) {
    return { type: 'choice', choice: fakeKind(state, name.slice('kind_'.length), labels), confidence: 0.8 }
  }
  return { type: 'choice', choice: labels[0] ?? 'none', confidence: 0.5 }
}

function fakeEnough(state: FakeState): number {
  const hasHead = state.cards.some((c) => c.stratum === 'head' && c.read)
  const verCards = state.cards.some((c) => c.stratum === 'verification')
  const hasVer = !verCards || state.cards.some((c) => c.stratum === 'verification' && c.read)
  const unreadAnchor = state.cards.some(
    (c) => !c.read && (ANCHOR_STRATA as readonly string[]).includes(c.stratum),
  )
  return hasHead && hasVer && !unreadAnchor ? 0.92 : 0.2
}

function fakeSkel(state: FakeState, id: string): number {
  const card = state.cards.find((c) => c.id === id)
  if (card === undefined || !card.read) return 0.05
  if ((ANCHOR_STRATA as readonly string[]).includes(card.stratum)) return 0.9
  return 0.1
}

function fakeScenario(state: FakeState, labels: readonly string[]): string {
  const blob = state.cards.map((c) => `${c.head}\n${c.excerpt}`).join('\n').toLowerCase()
  if (/pytest|test_fix|tests passed|failing test/.test(blob)) return pick(labels, 'test_fix', 'implement')
  if (blob.includes('refactor')) return pick(labels, 'refactor', 'implement')
  if (blob.includes('investigat')) return pick(labels, 'investigate', 'implement')
  if (/error|bug|debug|exception/.test(blob)) return pick(labels, 'debug', 'implement')
  return pick(labels, 'implement', 'implement')
}

function fakeStratum(state: FakeState, labels: readonly string[]): string {
  for (const stratum of ['error_retry', 'tool_failure_dense', 'verification', 'head'] as const) {
    const unread = state.cards.some((c) => c.stratum === stratum && !c.read)
    if (unread && labels.includes(stratum)) return stratum
  }
  return pick(labels, 'none', 'none')
}

function fakeGap(state: FakeState, labels: readonly string[]): string {
  const prefer = ['verification', 'error_retry', 'tool_failure_dense', 'head']
  for (const stratum of prefer) {
    const card = state.cards.find((c) => c.stratum === stratum && !c.read && labels.includes(c.id))
    if (card !== undefined) return card.id
  }
  const unread = state.unread_ids.find((id) => labels.includes(id))
  if (unread !== undefined) return unread
  return pick(labels, 'none', 'none')
}

function fakeKind(state: FakeState, id: string, labels: readonly string[]): string {
  const card = state.cards.find((c) => c.id === id)
  const want =
    card?.stratum === 'verification'
      ? 'verification_anchor'
      : card?.stratum === 'error_retry' || card?.stratum === 'tool_failure_dense'
        ? 'turning_point'
        : 'main_path_hypothesis'
  return pick(labels, want, 'main_path_hypothesis')
}

function pick(labels: readonly string[], want: string, fallback: string): string {
  if (labels.includes(want)) return want
  if (labels.includes(fallback)) return fallback
  return labels[0] ?? fallback
}

function parseFakeState(state: EntryType): FakeState {
  const rec = asRecord(state)
  if (rec === undefined) return { cards: [], unread_ids: [] }
  const cards: FakeCard[] = []
  if (Array.isArray(rec.cards)) {
    for (const item of rec.cards) {
      const card = asRecord(item)
      if (card === undefined || typeof card.id !== 'string') continue
      cards.push({
        id: card.id,
        stratum: typeof card.stratum === 'string' ? card.stratum : '',
        head: typeof card.head === 'string' ? card.head : '',
        read: card.read === true,
        excerpt: typeof card.excerpt === 'string' ? card.excerpt : '',
      })
    }
  }
  const unread_ids = Array.isArray(rec.unread_ids)
    ? rec.unread_ids.filter((id): id is string => typeof id === 'string')
    : []
  return { cards, unread_ids }
}

function normalizeAnswers(answers: object): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {}
  for (const [name, value] of Object.entries(answers)) {
    const normalized = normalizeAnswer(value)
    if (normalized !== undefined) out[name] = normalized
  }
  return out
}

function normalizeAnswer(value: unknown): JevAnswer | undefined {
  const rec = asRecord(value)
  if (rec === undefined || typeof rec.type !== 'string') return undefined
  if (rec.type === 'noul' && typeof rec.noul === 'number' && Number.isFinite(rec.noul)) {
    return { type: 'noul', noul: clamp01(rec.noul) }
  }
  if (rec.type === 'choice' && typeof rec.choice === 'string') {
    const confidence = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? rec.confidence : 0
    return { type: 'choice', choice: rec.choice, confidence }
  }
  if (rec.type === 'score' && typeof rec.score === 'number' && Number.isFinite(rec.score)) {
    const confidence = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? rec.confidence : 0
    return { type: 'score', score: rec.score, confidence }
  }
  return undefined
}

function readUsage(usage: unknown): { input_tokens: number; output_tokens: number } {
  const rec = asRecord(usage)
  const input_tokens = rec !== undefined && typeof rec.input_tokens === 'number' ? rec.input_tokens : 0
  const output_tokens = rec !== undefined && typeof rec.output_tokens === 'number' ? rec.output_tokens : 0
  return { input_tokens, output_tokens }
}

function readEnv(env: NodeJS.Dict<string>, key: string): string {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
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
