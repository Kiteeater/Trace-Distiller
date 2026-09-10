import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateTokens } from '../../utils/tokens.ts'
import { resolveTimeoutMs, withTimeout } from '../../utils/timeout.ts'
import {
  PI_FAILURE_RETRY,
  SESSION_CALL_TIMEOUT_MS,
  SESSION_TIMEOUT_ENV,
} from '../../constant/window.ts'
import { L4_REPLAY_CODING_TOOLS, resolvePiToolRegistration } from './hole_tools.ts'
import type { AgentRole } from '../../enums/agent_role.ts'
import { LABELS, type Label } from '../../enums/label.ts'
import type { TokenUsage } from './skeleton_pass.ts'

/** 按 AgentRole 选模型档。模型名本身不进 constant。 */
export const MODEL_ENV_BY_ROLE: Record<AgentRole, string> = {
  hole_a_skeleton: 'TRACE_DISTILLER_MODEL_HOLE_A',
  hole_b_label: 'TRACE_DISTILLER_MODEL_HOLE_B',
  l4_qa: 'TRACE_DISTILLER_MODEL_L4',
  l4_replay: 'TRACE_DISTILLER_MODEL_L4',
  l4_review: 'TRACE_DISTILLER_MODEL_L4',
}

export const GATEWAY_API_BASE_ENV = 'TRACE_DISTILLER_API_BASE'
export const GATEWAY_API_KEY_ENV = 'TRACE_DISTILLER_API_KEY'
export const GATEWAY_PROVIDER_ENV = 'TRACE_DISTILLER_PROVIDER'
export const DEFAULT_GATEWAY_PROVIDER = 'macaron'

export const CUSTOM_PROVIDER_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
} as const

export interface CustomGatewayEnv {
  baseUrl: string
  apiKey: string
  provider: string
}

export interface CustomProviderRegisterConfig {
  baseUrl: string
  api: 'openai-completions'
  apiKey: string
  authHeader: true
  compat: typeof CUSTOM_PROVIDER_COMPAT
  models: Array<{
    id: string
    name: string
    reasoning: false
    input: Array<'text' | 'image'>
    contextWindow: number
    maxTokens: number
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    compat: typeof CUSTOM_PROVIDER_COMPAT
  }>
}

export interface CustomProviderRegistration {
  provider: string
  modelId: string
  config: CustomProviderRegisterConfig
}

export interface GatewayAuthStorage {
  set(provider: string, credential: { type: 'api_key'; key: string }): void
}

export interface GatewayModelRegistry<T = unknown> {
  registerProvider(name: string, config: CustomProviderRegisterConfig): void
  find(provider: string, id: string): T | undefined
}

export type ApplyCustomGatewayResult<T> = { used: false } | { used: true; model: T | undefined }

/** 洞会话默认不挂 pi codingTools（read/bash/edit/write）。 */
export const DEFAULT_HOLE_TOOL_NAMES: readonly string[] = []

const BANNED_CODING_TOOLS = ['read', 'bash', 'edit', 'write'] as const

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface SessionPromptInput {
  text: string
  system?: string
  skill_text?: string
  skeleton_text?: string
  messages?: readonly SessionMessage[]
}

export interface SessionToolCall {
  name: string
  arguments: unknown
}

export interface SessionPromptResult {
  text: string
  json: unknown | null
  tool_calls: SessionToolCall[]
  usage: TokenUsage
}

export interface SessionFactoryOpts {
  role: AgentRole
  model?: string
  backend?: SessionBackend
  /** 洞工具名；默认空，禁止默认 codingTools。L4 replay 有 cwd 时可挂 coding tools。 */
  tools?: readonly string[]
  /** L4 replay 工作目录（真仓库副本）。洞 A/B 忽略。 */
  cwd?: string
}

export interface ResolvedSessionOpts {
  role: AgentRole
  model: string
  tools: readonly string[]
  cwd?: string
}

export interface PiSessionHandle {
  readonly role: AgentRole
  readonly model: string
  readonly tools: readonly string[]
  prompt(input: SessionPromptInput): Promise<SessionPromptResult>
  /** 触发内核建会话。假后端立即完成。 */
  attach(): Promise<void>
  activeToolNames(): Promise<readonly string[]>
  dispose(): void
}

export interface SessionBackend {
  open(opts: ResolvedSessionOpts): PiSessionHandle
}

export const SPIKE_JSON_KIND = 'spike_label' as const

export interface SpikeLabelJson {
  kind: typeof SPIKE_JSON_KIND
  segment_id: string
  label: Label
  confidence: number
}

let injectedBackend: SessionBackend | undefined

export function setSessionBackend(backend: SessionBackend | undefined): void {
  injectedBackend = backend
}

export function hasInjectedSessionBackend(): boolean {
  return injectedBackend !== undefined
}

/** 洞 A 或洞 B 模型档已设时，CLI 才走 with_llm（无假后端时）。 */
export function holeModelsConfigured(env: NodeJS.Dict<string> = process.env): boolean {
  const a = env[MODEL_ENV_BY_ROLE.hole_a_skeleton]
  const b = env[MODEL_ENV_BY_ROLE.hole_b_label]
  return (typeof a === 'string' && a.length > 0) || (typeof b === 'string' && b.length > 0)
}

/** L4（QA / replay / review）共用 TRACE_DISTILLER_MODEL_L4。 */
export function l4ModelConfigured(env: NodeJS.Dict<string> = process.env): boolean {
  const v = env[MODEL_ENV_BY_ROLE.l4_qa]
  return typeof v === 'string' && v.length > 0
}

/** 假后端已注入，或真模型档已设。CLI eval --qa/--replay 无此后端则跳过。 */
export function l4BackendAvailable(env: NodeJS.Dict<string> = process.env): boolean {
  return hasInjectedSessionBackend() || l4ModelConfigured(env)
}

/** 单次会话调用硬超时。env TRACE_DISTILLER_SESSION_TIMEOUT_MS 可覆盖。 */
export function resolveSessionTimeoutMs(env: NodeJS.Dict<string> = process.env): number {
  return resolveTimeoutMs(env[SESSION_TIMEOUT_ENV], SESSION_CALL_TIMEOUT_MS)
}

export const L4_QA_JSON_KIND = 'l4_qa_v0' as const
export const L4_REPLAY_JSON_KIND = 'l4_replay_v0' as const
export const L4_REVIEW_JSON_KIND = 'l4_review_v0' as const

export function resolveSessionModel(role: AgentRole, model?: string, env: NodeJS.Dict<string> = process.env): string {
  if (model !== undefined && model.length > 0) return model
  const key = MODEL_ENV_BY_ROLE[role]
  const fromEnv = env[key]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return `unspecified:${role}`
}

export function readCustomGatewayEnv(env: NodeJS.Dict<string> = process.env): CustomGatewayEnv | undefined {
  const baseUrl = env[GATEWAY_API_BASE_ENV]
  const apiKey = env[GATEWAY_API_KEY_ENV]
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  if (typeof apiKey !== 'string' || apiKey.length === 0) return undefined
  const providerRaw = env[GATEWAY_PROVIDER_ENV]
  const provider =
    typeof providerRaw === 'string' && providerRaw.length > 0 ? providerRaw : DEFAULT_GATEWAY_PROVIDER
  return { baseUrl, apiKey, provider }
}

export function parseProviderModel(model: string): { provider: string; id: string } | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0) return undefined
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1)
  if (provider.length === 0 || id.length === 0) return undefined
  return { provider, id }
}

export function resolveCustomGatewayModelRef(
  model: string,
  gatewayProvider: string,
): { provider: string; id: string } {
  const parsed = parseProviderModel(model)
  if (parsed !== undefined) return parsed
  return { provider: gatewayProvider, id: model }
}

export function buildCustomProviderRegistration(input: {
  provider: string
  modelId: string
  baseUrl: string
  apiKey: string
}): CustomProviderRegistration {
  const compat = { ...CUSTOM_PROVIDER_COMPAT }
  return {
    provider: input.provider,
    modelId: input.modelId,
    config: {
      baseUrl: input.baseUrl,
      api: 'openai-completions',
      apiKey: input.apiKey,
      authHeader: true,
      compat,
      models: [
        {
          id: input.modelId,
          name: input.modelId,
          reasoning: false,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat,
        },
      ],
    },
  }
}

/** 设了 API_BASE+API_KEY 时 registerProvider + find，不走内置 getModel。 */
export function applyCustomGateway<T>(
  registry: GatewayModelRegistry<T>,
  authStorage: GatewayAuthStorage,
  model: string,
  env: NodeJS.Dict<string> = process.env,
): ApplyCustomGatewayResult<T> {
  const gateway = readCustomGatewayEnv(env)
  if (gateway === undefined) return { used: false }
  const ref = resolveCustomGatewayModelRef(model, gateway.provider)
  const registration = buildCustomProviderRegistration({
    provider: ref.provider,
    modelId: ref.id,
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
  })
  authStorage.set(ref.provider, { type: 'api_key', key: gateway.apiKey })
  registry.registerProvider(registration.provider, registration.config)
  return { used: true, model: registry.find(ref.provider, ref.id) }
}

export function composeSessionPrompt(input: SessionPromptInput): string {
  const chunks: string[] = []
  const preamble = [input.system, input.skill_text, input.skeleton_text].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  )
  if (preamble.length > 0) chunks.push(preamble.join('\n\n'))
  for (const msg of input.messages ?? []) {
    chunks.push(`${msg.role}:\n${msg.content}`)
  }
  chunks.push(input.text)
  return chunks.join('\n\n')
}

export function parseStructuredJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  return JSON.parse(candidate) as unknown
}

export function isSpikeLabelJson(value: unknown): value is SpikeLabelJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  if (rec.kind !== SPIKE_JSON_KIND) return false
  if (typeof rec.segment_id !== 'string' || rec.segment_id.length === 0) return false
  if (typeof rec.label !== 'string' || !(LABELS as readonly string[]).includes(rec.label)) return false
  return typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) && rec.confidence >= 0 && rec.confidence <= 1
}

export async function withPiRetry<T>(op: () => Promise<T>): Promise<T> {
  const attempts = PI_FAILURE_RETRY + 1
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await op()
    } catch (err) {
      last = err
    }
  }
  throw last
}

export function defaultSpikeLabelJson(): SpikeLabelJson {
  return {
    kind: SPIKE_JSON_KIND,
    segment_id: 's0001',
    label: 'key_decision',
    confidence: 0.91,
  }
}

export class FakeSessionBackend implements SessionBackend {
  readonly calls: Array<{
    role: AgentRole
    model: string
    tools: readonly string[]
    input: SessionPromptInput
    composed: string
  }> = []
  private readonly respond: (
    input: SessionPromptInput,
    opts: ResolvedSessionOpts,
  ) => SessionPromptResult | Promise<SessionPromptResult>

  constructor(
    respond: (
      input: SessionPromptInput,
      opts: ResolvedSessionOpts,
    ) => SessionPromptResult | Promise<SessionPromptResult> = defaultFakeRespond,
  ) {
    this.respond = respond
  }

  open(opts: ResolvedSessionOpts): PiSessionHandle {
    return new FakeSessionHandle(this, opts)
  }

  record(opts: ResolvedSessionOpts, input: SessionPromptInput, composed: string): void {
    this.calls.push({ role: opts.role, model: opts.model, tools: opts.tools, input, composed })
  }

  reply(input: SessionPromptInput, opts: ResolvedSessionOpts): SessionPromptResult | Promise<SessionPromptResult> {
    return this.respond(input, opts)
  }
}

function defaultFakeRespond(input: SessionPromptInput, opts: ResolvedSessionOpts): SessionPromptResult {
  if (opts.role === 'hole_b_label' && wantsCheckContinuity(input)) {
    const pair = fakeContinuityArgs(input.text)
    return {
      text: '',
      json: null,
      tool_calls: [{ name: 'check_continuity', arguments: pair }],
      usage: { role: opts.role, input_tokens: Math.max(1, input.text.length), output_tokens: 8 },
    }
  }
  const json = defaultFakeJsonForRole(input, opts.role)
  const tool_calls =
    opts.role === 'hole_a_skeleton' || opts.role === 'hole_b_label'
      ? [{ name: 'label_segment', arguments: json }]
      : []
  return {
    text: JSON.stringify(json),
    json,
    tool_calls,
    usage: { role: opts.role, input_tokens: Math.max(1, input.text.length), output_tokens: 8 },
  }
}

function wantsCheckContinuity(input: SessionPromptInput): boolean {
  const blob = `${input.system ?? ''}
${input.text}`
  return blob.includes('check_continuity')
}

function fakeContinuityArgs(text: string): {
  left_id: string
  right_id: string
  reachable: boolean
  score: number
  reason: string
} {
  const left = text.match(/left:\s*\{[\s\S]*?"id"\s*:\s*"([^"]+)"/)
  const right = text.match(/right:\s*\{[\s\S]*?"id"\s*:\s*"([^"]+)"/)
  return {
    left_id: left?.[1] ?? 's0001',
    right_id: right?.[1] ?? 's0002',
    reachable: true,
    score: 5,
    reason: 'fake continuity',
  }
}

function defaultFakeJsonForRole(input: SessionPromptInput, role: AgentRole): unknown {
  if (role === 'l4_qa') return defaultFakeQaJson(input)
  if (role === 'l4_replay') return defaultFakeReplayJson(input)
  if (role === 'l4_review') return defaultFakeReviewJson(input)
  return defaultSpikeLabelJson()
}

export function defaultFakeQaJson(input: SessionPromptInput): {
  kind: typeof L4_QA_JSON_KIND
  items: Array<{ id: string; question: string; answer: string; correct: boolean }>
} {
  const marked = readMarkedJson(input.text, 'QUESTIONS_JSON')
  const questions = parseQaQuestionList(marked)
  const items =
    questions.length > 0
      ? questions.map((q) => ({
          id: q.id,
          question: q.question,
          answer: `fake:${q.id}`,
          correct: true,
        }))
      : [
          {
            id: 'q1',
            question: 'What was the task?',
            answer: 'fake:q1',
            correct: true,
          },
        ]
  return { kind: L4_QA_JSON_KIND, items }
}

export function defaultFakeReplayJson(input?: SessionPromptInput): {
  kind: typeof L4_REPLAY_JSON_KIND
  success: boolean
  note: string
} {
  const marked = input !== undefined ? readMarkedJson(input.text, 'TASK_JSON') : undefined
  const cwd =
    marked !== null &&
    typeof marked === 'object' &&
    !Array.isArray(marked) &&
    typeof (marked as { cwd?: unknown }).cwd === 'string'
      ? (marked as { cwd: string }).cwd
      : undefined
  if (cwd !== undefined && cwd.length > 0) {
    if (!existsSync(cwd)) {
      return {
        kind: L4_REPLAY_JSON_KIND,
        success: false,
        note: `fake backend; workspace cwd missing: ${cwd}`,
      }
    }
    const healed = applyFakeReplayHeal(cwd)
    return {
      kind: L4_REPLAY_JSON_KIND,
      success: true,
      note: healed
        ? 'fake backend; applied deterministic workspace heal (CI only; not mint fidelity)'
        : 'fake backend; workspace cwd present (no heal needed)',
    }
  }
  return {
    kind: L4_REPLAY_JSON_KIND,
    success: true,
    note: 'fake backend; real replay success needs repo+model',
  }
}


/**
 * Deterministic CI heal for known fixtures:
 * - add-fix: a - b → a + b in add.ts
 * - mul-fix: a + b → a * b in mul.ts
 * Real mint must edit via coding tools; this only makes FakeSessionBackend + verify gate pass.
 */
export function applyFakeReplayHeal(cwd: string): boolean {
  let healed = false
  const addTarget = join(cwd, 'add.ts')
  if (existsSync(addTarget)) {
    const before = readFileSync(addTarget, 'utf8')
    if (before.includes('a - b')) {
      writeFileSync(addTarget, before.replaceAll('a - b', 'a + b'), 'utf8')
      healed = true
    }
  }
  const mulTarget = join(cwd, 'mul.ts')
  if (existsSync(mulTarget)) {
    const before = readFileSync(mulTarget, 'utf8')
    if (before.includes('a + b')) {
      writeFileSync(mulTarget, before.replaceAll('a + b', 'a * b'), 'utf8')
      healed = true
    }
  }
  return healed
}

export function defaultFakeReviewJson(input: SessionPromptInput): {
  kind: typeof L4_REVIEW_JSON_KIND
  turning_point_segment_ids: string[]
  evidence_segment_ids: string[]
} {
  const ids = playbackCardIdsFromPrompt(input.text)
  return {
    kind: L4_REVIEW_JSON_KIND,
    turning_point_segment_ids: ids.slice(0, 1),
    evidence_segment_ids: ids.slice(-1),
  }
}

/** 会话正文里的标记块：---NAME--- json ---END_NAME--- */
export function readMarkedJson(text: string, name: string): unknown | undefined {
  const start = `---${name}---`
  const end = `---END_${name}---`
  const a = text.indexOf(start)
  const b = text.indexOf(end)
  if (a < 0 || b < 0 || b <= a) return undefined
  const raw = text.slice(a + start.length, b).trim()
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export function formatMarkedJson(name: string, value: unknown): string {
  return `---${name}---\n${JSON.stringify(value)}\n---END_${name}---`
}

/** Playback 卡片索引。L4 用；不含 warrant / skeleton。 */
export function playbackIndexForL4(playback: {
  trace_id: string
  cards: ReadonlyArray<{
    id: string
    tool: string
    sig: string
    outcome: string
    tokens: number
    focus: string
    head: string
  }>
  collapsed: ReadonlyArray<{ segment_id: string; summary: string }>
}): Record<string, unknown> {
  return {
    trace_id: playback.trace_id,
    cards: playback.cards.map((c) => ({
      id: c.id,
      tool: c.tool,
      sig: c.sig,
      outcome: c.outcome,
      tokens: c.tokens,
      focus: c.focus,
      head: c.head,
    })),
    collapsed: playback.collapsed.map((c) => ({
      segment_id: c.segment_id,
      summary: c.summary,
    })),
  }
}

function parseQaQuestionList(value: unknown): Array<{ id: string; question: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ id: string; question: string }> = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || rec.id.length === 0) continue
    const question = typeof rec.question === 'string' ? rec.question : ''
    out.push({ id: rec.id, question })
  }
  return out
}

function playbackCardIdsFromPrompt(text: string): string[] {
  const marked = readMarkedJson(text, 'PLAYBACK_JSON')
  if (typeof marked !== 'object' || marked === null) return []
  const cards = (marked as { cards?: unknown }).cards
  if (!Array.isArray(cards)) return []
  const ids: string[] = []
  for (const card of cards) {
    if (typeof card !== 'object' || card === null) continue
    const id = (card as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

class FakeSessionHandle implements PiSessionHandle {
  readonly role: AgentRole
  readonly model: string
  readonly tools: readonly string[]
  private readonly backend: FakeSessionBackend
  private readonly opts: ResolvedSessionOpts

  constructor(backend: FakeSessionBackend, opts: ResolvedSessionOpts) {
    this.backend = backend
    this.opts = opts
    this.role = opts.role
    this.model = opts.model
    this.tools = opts.tools
  }

  async attach(): Promise<void> {}

  async activeToolNames(): Promise<readonly string[]> {
    return this.tools
  }

  async prompt(input: SessionPromptInput): Promise<SessionPromptResult> {
    const composed = composeSessionPrompt(input)
    this.backend.record(this.opts, input, composed)
    return this.backend.reply(input, this.opts)
  }

  dispose(): void {}
}

export class PiSessionBackend implements SessionBackend {
  open(opts: ResolvedSessionOpts): PiSessionHandle {
    return new PiSessionHandleImpl(opts)
  }
}

class PiSessionHandleImpl implements PiSessionHandle {
  readonly role: AgentRole
  readonly model: string
  readonly tools: readonly string[]
  private readonly opts: ResolvedSessionOpts
  private session: PiAgentSession | undefined
  private disposed = false

  constructor(opts: ResolvedSessionOpts) {
    this.opts = opts
    this.role = opts.role
    this.model = opts.model
    this.tools = opts.tools
    const holeRole = opts.role === 'hole_a_skeleton' || opts.role === 'hole_b_label'
    if (holeRole) {
      for (const name of opts.tools) {
        if ((BANNED_CODING_TOOLS as readonly string[]).includes(name)) {
          throw new Error(`hole sessions must not enable coding tool '${name}'`)
        }
      }
    }
  }

  async attach(): Promise<void> {
    await this.ensureSession()
  }

  async activeToolNames(): Promise<readonly string[]> {
    const session = await this.ensureSession()
    return session.getActiveToolNames()
  }

  async prompt(input: SessionPromptInput): Promise<SessionPromptResult> {
    const session = await this.ensureSession()
    const composed = composeSessionPrompt(input)
    await session.prompt(composed)
    const extracted = extractPiResult(session.messages, this.role)
    let json: unknown | null = extracted.json
    if (json === null && extracted.text.trim().length > 0) {
      try {
        json = parseStructuredJson(extracted.text)
      } catch {
        json = null
      }
    }
    let usage = extracted.usage
    if (usage === undefined || usage.input_tokens + usage.output_tokens === 0) {
      usage = {
        role: this.role,
        input_tokens: estimateTokens(composed),
        output_tokens: Math.max(
          estimateTokens(extracted.text),
          extracted.tool_calls.length * 16,
        ),
      }
    }
    return {
      text: extracted.text,
      json,
      tool_calls: extracted.tool_calls,
      usage,
    }
  }

  dispose(): void {
    this.disposed = true
    this.session?.dispose()
    this.session = undefined
  }

  private async ensureSession(): Promise<PiAgentSession> {
    if (this.disposed) throw new Error('session already disposed')
    if (this.session !== undefined) return this.session
    this.session = await createPiKernelSession(this.opts)
    return this.session
  }
}

interface PiAgentSession {
  prompt(text: string): Promise<void>
  dispose(): void
  getActiveToolNames(): string[]
  readonly messages: readonly unknown[]
}

async function createPiKernelSession(opts: ResolvedSessionOpts): Promise<PiAgentSession> {
  const pi = await import('@mariozechner/pi-coding-agent')
  const {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
  } = pi

  const cwd = opts.cwd ?? process.cwd()
  const authStorage = AuthStorage.inMemory()
  const settingsManager = SettingsManager.inMemory()
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(tmpdir(), 'trace-distiller-pi-agent'),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: '',
  })
  await resourceLoader.reload()

  const modelRegistry = ModelRegistry.inMemory(authStorage)
  const toolReg = resolvePiToolRegistration(opts.tools)
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
    cwd,
    tools: toolReg.tools,
    thinkingLevel: 'off',
  }
  if (toolReg.noTools !== undefined) {
    sessionOpts.noTools = toolReg.noTools
  }
  if (toolReg.customTools !== undefined && toolReg.customTools.length > 0) {
    sessionOpts.customTools = toolReg.customTools
  }

  const gateway = applyCustomGateway(modelRegistry, authStorage, opts.model)
  if (gateway.used) {
    if (gateway.model === undefined) {
      throw new Error(`custom gateway model not found: ${opts.model}`)
    }
    Object.assign(sessionOpts, { model: gateway.model })
  } else {
    const { getModel } = await import('@mariozechner/pi-ai')
    const resolved = tryResolvePiModel(getModel as (provider: string, id: string) => unknown, opts.model)
    if (resolved !== undefined) {
      Object.assign(sessionOpts, { model: resolved })
    }
  }

  const { session } = await createAgentSession(sessionOpts)
  return session
}

function tryResolvePiModel(getModelFn: (provider: string, id: string) => unknown, model: string): unknown {
  const parsed = parseProviderModel(model)
  if (parsed === undefined) return undefined
  try {
    return getModelFn(parsed.provider, parsed.id)
  } catch {
    return undefined
  }
}

/**
 * Read token usage from a pi-ai `Usage` object (or OpenAI/Anthropic aliases).
 * pi-ai canonical fields are `input` / `output` / `cacheRead` / `cacheWrite` /
 * `totalTokens`. Missing those used to fall through to estimateTokens and
 * inflate distill_cost_ratio on real mint.
 *
 * Cache read/write is part of tokens processed (pi splits it out of `input`).
 * `cost.input` is dollars — never treat it as tokens.
 */
export function readPiUsage(
  usageRaw: unknown,
): { input_tokens: number; output_tokens: number } | undefined {
  if (typeof usageRaw !== 'object' || usageRaw === null || Array.isArray(usageRaw)) {
    return undefined
  }
  const u = usageRaw as Record<string, unknown>
  const input = firstFiniteNumber(u.input_tokens, u.inputTokens, u.prompt_tokens, u.input)
  const output = firstFiniteNumber(u.output_tokens, u.outputTokens, u.completion_tokens, u.output)
  const cacheRead = firstFiniteNumber(u.cacheRead, u.cache_read_input_tokens, u.cacheReadInputTokens) ?? 0
  const cacheWrite = firstFiniteNumber(u.cacheWrite, u.cache_creation_input_tokens, u.cacheWriteInputTokens) ?? 0
  const total = firstFiniteNumber(u.totalTokens, u.total_tokens)
  if (input === undefined && output === undefined && total === undefined) return undefined
  const input_tokens = (input ?? 0) + cacheRead + cacheWrite
  const output_tokens = output ?? 0
  if (input_tokens + output_tokens === 0 && total !== undefined && total > 0) {
    return { input_tokens: total, output_tokens: 0 }
  }
  return { input_tokens, output_tokens }
}

function firstFiniteNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return undefined
}

function extractPiResult(
  messages: readonly unknown[],
  role: AgentRole,
): {
  text: string
  json: unknown | null
  tool_calls: SessionToolCall[]
  usage?: TokenUsage
} {
  const texts: string[] = []
  const tool_calls: SessionToolCall[] = []
  let input_tokens = 0
  let output_tokens = 0
  let sawUsage = false
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const msg = raw as Record<string, unknown>
    // Per-turn usage lives on assistant messages (pi-ai AssistantMessage.usage).
    // Summing turns is correct: each completion is billed separately, not cumulative.
    if (msg.role === 'assistant') {
      const parsed = readPiUsage(msg.usage)
      if (parsed !== undefined) {
        input_tokens += parsed.input_tokens
        output_tokens += parsed.output_tokens
        sawUsage = true
      }
    }
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') {
      texts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      if ((b.type === 'toolCall' || b.type === 'tool_use') && typeof b.name === 'string') {
        const args = b.arguments ?? b.input ?? {}
        tool_calls.push({ name: b.name, arguments: args })
      }
    }
  }
  const out: {
    text: string
    json: unknown | null
    tool_calls: SessionToolCall[]
    usage?: TokenUsage
  } = { text: texts.join('\n'), json: null, tool_calls }
  if (sawUsage) {
    out.usage = { role, input_tokens, output_tokens }
  }
  return out
}

/** Test/observable: usage extracted from pi session messages (assistant turns only). */
export function usageFromPiMessages(
  messages: readonly unknown[],
  role: AgentRole,
): TokenUsage | undefined {
  return extractPiResult(messages, role).usage
}

function wrapRetry(handle: PiSessionHandle, timeoutMs: number = resolveSessionTimeoutMs()): PiSessionHandle {
  const timed = <T>(label: string, op: () => Promise<T>): Promise<T> =>
    withTimeout(withPiRetry(op), timeoutMs, label)
  return {
    role: handle.role,
    model: handle.model,
    tools: handle.tools,
    prompt: (input) => timed(`session.prompt(${handle.role})`, () => handle.prompt(input)),
    attach: () => timed(`session.attach(${handle.role})`, () => handle.attach()),
    activeToolNames: () => timed(`session.activeToolNames(${handle.role})`, () => handle.activeToolNames()),
    dispose: () => handle.dispose(),
  }
}

/**
 * L4 与两洞共用的会话工厂。不算第三洞。eval 必须走这里，禁止自己 createAgentSession。
 * 生产默认 PiSessionBackend（createAgentSession + SessionManager.inMemory，无 codingTools）。
 * 测试注入 FakeSessionBackend。失败重试 PI_FAILURE_RETRY 次再向上抛。
 * 每次 prompt/attach 有 SESSION_CALL_TIMEOUT_MS 硬超时（可 env 覆盖），避免 mint 无限挂起。
 */
export function openSession(opts: SessionFactoryOpts): PiSessionHandle {
  const resolved: ResolvedSessionOpts = {
    role: opts.role,
    model: resolveSessionModel(opts.role, opts.model),
    tools: opts.tools ?? DEFAULT_HOLE_TOOL_NAMES,
  }
  if (opts.cwd !== undefined && opts.cwd.length > 0) {
    resolved.cwd = opts.cwd
  }
  const backend = opts.backend ?? injectedBackend ?? new PiSessionBackend()
  return wrapRetry(backend.open(resolved))
}

export function openReviewSession(opts?: Omit<SessionFactoryOpts, 'role'>): PiSessionHandle {
  return openSession({ ...opts, role: 'l4_review' })
}

/**
 * L4 重放干净会话。传入 cwd（真仓库副本）时默认挂 coding tools，
 * 让真 mint 能在工作区里改文件/跑验证；洞 A/B 仍禁止 coding tools。
 */
export function openReplaySession(opts?: Omit<SessionFactoryOpts, 'role'>): PiSessionHandle {
  const cwd = opts?.cwd
  const tools =
    opts?.tools ??
    (cwd !== undefined && cwd.length > 0 ? L4_REPLAY_CODING_TOOLS : DEFAULT_HOLE_TOOL_NAMES)
  return openSession({ ...opts, role: 'l4_replay', tools })
}

export function openQaSession(opts?: Omit<SessionFactoryOpts, 'role'>): PiSessionHandle {
  return openSession({ ...opts, role: 'l4_qa' })
}
