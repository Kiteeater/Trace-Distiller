import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PI_FAILURE_RETRY } from '../../constant/window.ts'
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
  /** 洞工具名；默认空，禁止默认 codingTools。 */
  tools?: readonly string[]
}

export interface ResolvedSessionOpts {
  role: AgentRole
  model: string
  tools: readonly string[]
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

export function resolveSessionModel(role: AgentRole, model?: string, env: NodeJS.Dict<string> = process.env): string {
  if (model !== undefined && model.length > 0) return model
  const key = MODEL_ENV_BY_ROLE[role]
  const fromEnv = env[key]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return `unspecified:${role}`
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
  const json = defaultSpikeLabelJson()
  return {
    text: JSON.stringify(json),
    json,
    tool_calls: [{ name: 'label_segment', arguments: json }],
    usage: { role: opts.role, input_tokens: Math.max(1, input.text.length), output_tokens: 8 },
  }
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
    for (const name of opts.tools) {
      if ((BANNED_CODING_TOOLS as readonly string[]).includes(name)) {
        throw new Error(`hole sessions must not enable coding tool '${name}'`)
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
    const extracted = extractPiResult(session.messages)
    let json: unknown | null = extracted.json
    if (json === null && extracted.text.trim().length > 0) {
      try {
        json = parseStructuredJson(extracted.text)
      } catch {
        json = null
      }
    }
    return {
      text: extracted.text,
      json,
      tool_calls: extracted.tool_calls,
      usage: extracted.usage ?? { role: this.role, input_tokens: 0, output_tokens: 0 },
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
  const { getModel } = await import('@mariozechner/pi-ai')
  const {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
  } = pi

  const authStorage = AuthStorage.inMemory()
  const settingsManager = SettingsManager.inMemory()
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
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

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
    tools: [...opts.tools],
    thinkingLevel: 'off',
  }
  if (opts.tools.length === 0) {
    sessionOpts.noTools = 'all'
  }
  const resolved = tryResolvePiModel(getModel as (provider: string, id: string) => unknown, opts.model)
  if (resolved !== undefined) {
    Object.assign(sessionOpts, { model: resolved })
  }

  const { session } = await createAgentSession(sessionOpts)
  return session
}

function tryResolvePiModel(getModelFn: (provider: string, id: string) => unknown, model: string): unknown {
  const slash = model.indexOf('/')
  if (slash <= 0) return undefined
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1)
  if (provider.length === 0 || id.length === 0) return undefined
  try {
    return getModelFn(provider, id)
  } catch {
    return undefined
  }
}

function extractPiResult(messages: readonly unknown[]): {
  text: string
  json: unknown | null
  tool_calls: SessionToolCall[]
  usage?: TokenUsage
} {
  const texts: string[] = []
  const tool_calls: SessionToolCall[] = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const msg = raw as Record<string, unknown>
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
  return { text: texts.join('\n'), json: null, tool_calls }
}

function wrapRetry(handle: PiSessionHandle): PiSessionHandle {
  return {
    role: handle.role,
    model: handle.model,
    tools: handle.tools,
    prompt: (input) => withPiRetry(() => handle.prompt(input)),
    attach: () => withPiRetry(() => handle.attach()),
    activeToolNames: () => withPiRetry(() => handle.activeToolNames()),
    dispose: () => handle.dispose(),
  }
}

/**
 * L4 与两洞共用的会话工厂。不算第三洞。eval 必须走这里，禁止自己 createAgentSession。
 * 生产默认 PiSessionBackend（createAgentSession + SessionManager.inMemory，无 codingTools）。
 * 测试注入 FakeSessionBackend。失败重试 PI_FAILURE_RETRY 次再向上抛。
 */
export function openSession(opts: SessionFactoryOpts): PiSessionHandle {
  const resolved: ResolvedSessionOpts = {
    role: opts.role,
    model: resolveSessionModel(opts.role, opts.model),
    tools: opts.tools ?? DEFAULT_HOLE_TOOL_NAMES,
  }
  const backend = opts.backend ?? injectedBackend ?? new PiSessionBackend()
  return wrapRetry(backend.open(resolved))
}

export function openReviewSession(opts?: Omit<SessionFactoryOpts, 'role'>): PiSessionHandle {
  return openSession({ ...opts, role: 'l4_review' })
}

export function openReplaySession(opts?: Omit<SessionFactoryOpts, 'role'>): PiSessionHandle {
  return openSession({ ...opts, role: 'l4_replay' })
}

export function openQaSession(opts?: Omit<SessionFactoryOpts, 'role'>): PiSessionHandle {
  return openSession({ ...opts, role: 'l4_qa' })
}
