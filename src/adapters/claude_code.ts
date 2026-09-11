import {
  AdmissionError,
  type GroundTruth,
  type GroundTruthKind,
  type RawTrace,
  type RawTurn,
  type RawTurnRole,
  type TraceSource,
} from '../types/raw_trace.ts'
import { parseJsonlText } from '../utils/jsonl.ts'
import { stableHash } from '../utils/hash.ts'
import { estimateTokens } from '../utils/tokens.ts'

export interface Adapter {
  readonly source: TraceSource
  sniff(input: unknown): boolean
  parse(input: unknown): RawTrace
}

export const claudeCodeAdapter: Adapter = {
  source: 'claude-code',
  sniff,
  parse,
}

const SOURCE: TraceSource = 'claude-code'

/** OPEN: ingest 开放问题 1。第二轮 user 短跟进上限；不够自信则拒。 */
const FOLLOW_UP_MAX_CHARS = 80

/** GT 证据邻近 Action Unit 半径（ingest：± 1–2）。 */
const GT_NEIGHBOR_AU_RADIUS = 2

const FOLLOW_UP_RE =
  /^(ok(ay)?|o+k+|yes|y|k|继续(吧|改)?|好的|好了|谢谢|thanks|thx|done|再试(一次)?|再跑(一次)?|可以|嗯+|对|please continue|go ahead|try again|lgtm|looks good)[\s.!?。！？]*$/iu

const NEW_TASK_HINT_RE =
  /(^|\n)\s*(另外[，,]?|还有个?(任务|需求)|下一个任务|换个任务|现在改做|unrelated|separately|now (please )?(implement|fix|add|refactor|write))\b/iu

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/giu

/**
 * OPEN: ingest 开放问题 2。测试类命令白名单，夹具阶段钉这一批。
 * 任意 exit 0（例如 ls）不算 GT。
 */
const TEST_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:(?:npx|pnpm|npm|yarn|bunx)\s+(?:exec\s+)?(?:run\s+)?(?:test|vitest|jest|mocha)\b|(?:bun|npm|pnpm|yarn)\s+test\b|(?:python(?:3)?\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+test\b|make\s+test\b|ctest\b|mvn\s+test\b|gradle(?:w)?\s+test\b|\bvitest\b|\bjest\b)/iu

const TEST_TOOL_NAMES = new Set(['bash', 'shell', 'test', 'pytest', 'jest', 'vitest'])

const CC_EVENT_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'progress',
  'file-history-snapshot',
  'summary',
  'queue-operation',
  'attachment',
  'compact_boundary',
])

const SKIP_EVENT_TYPES = new Set([
  'system',
  'progress',
  'file-history-snapshot',
  'summary',
  'queue-operation',
  'attachment',
  'compact_boundary',
  'ground_truth',
  'distiller_meta',
])

export function sniff(input: unknown): boolean {
  const records = tryRecords(input)
  if (records === undefined || records.length === 0) return false
  return records.some(isClaudeCodeEvent)
}

export function parse(input: unknown): RawTrace {
  const records = recordsOrThrow(input)
  if (!records.some(isClaudeCodeEvent)) {
    throw new AdmissionError('unparseable', 'not claude-code JSONL')
  }

  const explicit = extractExplicitMeta(records)
  const sessionId = firstSessionId(records)
  const turns = extractTurns(records)
  if (turns.length === 0) {
    throw new AdmissionError('unparseable', 'claude-code JSONL produced no turns')
  }

  rejectIfMultiTaskAmbiguous(turns)

  const inferred = inferLastSuccessfulTest(turns)
  const ground_truth = explicit.ground_truth ?? inferred
  if (ground_truth === undefined) {
    throw new AdmissionError(
      'no_ground_truth',
      'no explicit ground_truth metadata and no successful test-like tool result (verbal ack is not GT)',
    )
  }

  const evidenceTurnId = resolveEvidenceTurnId(turns, ground_truth, inferred)
  const anchor_turn_ids = buildAnchorTurnIds(turns, evidenceTurnId)
  const total_tokens = turns.reduce((sum, turn) => sum + turn.tokens, 0)
  const trace_id = resolveTraceId(explicit.trace_id, sessionId, records)

  return {
    meta: {
      trace_id,
      source: SOURCE,
      ground_truth_ref: ground_truth.evidence_ref,
      total_tokens,
    },
    ground_truth,
    turns,
    anchor_turn_ids,
  }
}

function recordsOrThrow(input: unknown): unknown[] {
  try {
    const records = tryRecords(input)
    if (records === undefined) {
      throw new AdmissionError('unparseable', 'input is not JSON, JSONL, or a record list')
    }
    if (records.length === 0) {
      throw new AdmissionError('unparseable', 'empty claude-code input')
    }
    return records
  } catch (error) {
    if (error instanceof AdmissionError) throw error
    const message = error instanceof Error ? error.message : 'unparseable'
    throw new AdmissionError('unparseable', message)
  }
}

function tryRecords(input: unknown): unknown[] | undefined {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.length === 0) return []
    if (trimmed.startsWith('[')) {
      const parsed: unknown = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : undefined
    }
    if (trimmed.startsWith('{') && !/[\r\n]/.test(trimmed)) {
      const parsed: unknown = JSON.parse(trimmed)
      return isRecord(parsed) ? unwrapEnvelope(parsed) : undefined
    }
    return parseJsonlText(input)
  }
  if (Array.isArray(input)) return input
  if (isRecord(input)) return unwrapEnvelope(input)
  return undefined
}

function unwrapEnvelope(obj: Record<string, unknown>): unknown[] {
  const inner = obj.records ?? obj.events ?? obj.messages
  if (Array.isArray(inner)) {
    const meta = envelopeMetaRecord(obj)
    return meta === undefined ? inner : [meta, ...inner]
  }
  return [obj]
}

function envelopeMetaRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!('ground_truth' in obj) && typeof obj.trace_id !== 'string') return undefined
  const rec: Record<string, unknown> = { type: 'distiller_meta' }
  if (typeof obj.trace_id === 'string') rec.trace_id = obj.trace_id
  if ('ground_truth' in obj) rec.ground_truth = obj.ground_truth
  return rec
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClaudeCodeEvent(value: unknown): boolean {
  if (!isRecord(value)) return false
  const type = value.type
  if (type === 'user' || type === 'assistant') {
    return isRecord(value.message) && (value.message.role === 'user' || value.message.role === 'assistant')
  }
  if (typeof type === 'string' && CC_EVENT_TYPES.has(type) && typeof value.sessionId === 'string') {
    return true
  }
  return false
}

function firstSessionId(records: unknown[]): string | undefined {
  for (const rec of records) {
    if (isRecord(rec) && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
      return rec.sessionId
    }
  }
  return undefined
}

function extractExplicitMeta(records: unknown[]): {
  ground_truth?: GroundTruth
  trace_id?: string
} {
  let ground_truth: GroundTruth | undefined
  let trace_id: string | undefined
  for (const rec of records) {
    if (!isRecord(rec)) continue
    if (typeof rec.trace_id === 'string' && rec.trace_id.length > 0 && trace_id === undefined) {
      trace_id = rec.trace_id
    }
    const gt = readGroundTruth(rec)
    if (gt !== undefined && ground_truth === undefined) ground_truth = gt
  }
  const out: { ground_truth?: GroundTruth; trace_id?: string } = {}
  if (ground_truth !== undefined) out.ground_truth = ground_truth
  if (trace_id !== undefined) out.trace_id = trace_id
  return out
}

function readGroundTruth(rec: Record<string, unknown>): GroundTruth | undefined {
  if (rec.type === 'ground_truth') {
    return asGroundTruth(rec)
  }
  if (rec.type === 'distiller_meta' && isRecord(rec.ground_truth)) {
    return asGroundTruth(rec.ground_truth)
  }
  if (isRecord(rec.ground_truth)) {
    return asGroundTruth(rec.ground_truth)
  }
  return undefined
}

function asGroundTruth(value: Record<string, unknown>): GroundTruth {
  const kind = value.kind
  const evidence_ref = value.evidence_ref
  if (kind !== 'tests_passed' && kind !== 'task_confirmed') {
    throw new AdmissionError('unparseable', 'ground_truth.kind must be tests_passed or task_confirmed')
  }
  if (typeof evidence_ref !== 'string' || evidence_ref.trim().length === 0) {
    throw new AdmissionError('no_ground_truth', 'ground_truth.evidence_ref is missing')
  }
  return { kind: kind as GroundTruthKind, evidence_ref: evidence_ref.trim() }
}

interface PendingCall {
  name: string
  args_json: string
}

function extractTurns(records: unknown[]): RawTurn[] {
  const turns: RawTurn[] = []
  const pending = new Map<string, PendingCall>()
  let seq = 0

  const allocId = (rec: Record<string, unknown>, part: number): string => {
    const uuid = typeof rec.uuid === 'string' && rec.uuid.length > 0 ? rec.uuid : undefined
    seq += 1
    if (uuid !== undefined) return part === 0 ? uuid : `${uuid}#${part}`
    return `t${String(seq).padStart(4, '0')}`
  }

  for (const rec of records) {
    if (!isRecord(rec)) continue
    const type = rec.type
    if (typeof type === 'string' && SKIP_EVENT_TYPES.has(type)) continue
    if (type !== 'user' && type !== 'assistant') continue
    if (!isRecord(rec.message)) continue

    const messageRole = rec.message.role === 'assistant' || type === 'assistant' ? 'assistant' : 'user'
    const blocks = normalizeContent(rec.message.content)
    let part = 0
    for (const block of blocks) {
      const turn = blockToTurn(block, messageRole, () => allocId(rec, part), pending)
      if (turn !== undefined) {
        turns.push(turn)
        part += 1
      }
    }
  }
  return turns
}

function normalizeContent(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  const blocks: Record<string, unknown>[] = []
  for (const item of content) {
    if (isRecord(item)) blocks.push(item)
    else if (typeof item === 'string') blocks.push({ type: 'text', text: item })
  }
  return blocks
}

function blockToTurn(
  block: Record<string, unknown>,
  messageRole: 'user' | 'assistant',
  id: () => string,
  pending: Map<string, PendingCall>,
): RawTurn | undefined {
  const type = block.type
  if (type === 'thinking' || type === 'redacted_thinking') {
    const thinking = typeof block.thinking === 'string' ? block.thinking : stringifyUnknown(block)
    return makeTurn(id(), 'thought', thinking)
  }
  if (type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    const toolUseId = typeof block.id === 'string' ? block.id : undefined
    const input = block.input ?? {}
    const args_obj: Record<string, unknown> = isRecord(input) ? { ...input } : { value: input }
    // Stamp call id so segmenter can pair batched tool_result by tool_use_id.
    if (toolUseId !== undefined) args_obj.tool_use_id = toolUseId
    const args_json = JSON.stringify(args_obj)
    if (toolUseId !== undefined) pending.set(toolUseId, { name, args_json })
    return makeTurn(id(), 'tool_call', args_json, { name, args_json })
  }
  if (type === 'tool_result') {
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    const call = toolUseId === undefined ? undefined : pending.get(toolUseId)
    const content = stringifyUnknown(block.content ?? '')
    const name = call?.name ?? 'unknown'
    const args_json = JSON.stringify({
      tool_use_id: toolUseId ?? null,
      is_error: block.is_error === true,
    })
    return makeTurn(id(), 'tool_result', content, { name, args_json })
  }
  if (type === 'text' || type === undefined) {
    const text = typeof block.text === 'string' ? block.text : stringifyUnknown(block)
    if (text.trim().length === 0) return undefined
    const role: RawTurnRole = messageRole === 'assistant' ? 'assistant' : 'user'
    return makeTurn(id(), role, text)
  }
  return undefined
}

function makeTurn(
  id: string,
  role: RawTurnRole,
  content: string,
  tool?: { name: string; args_json: string },
): RawTurn {
  const turn: RawTurn = {
    id,
    role,
    content,
    tokens: estimateTokens(content),
  }
  if (tool !== undefined) turn.tool = tool
  return turn
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item) && typeof item.text === 'string') return item.text
        return JSON.stringify(item)
      })
      .join('\n')
  }
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

function humanUserTexts(turns: RawTurn[]): string[] {
  const texts: string[] = []
  for (const turn of turns) {
    if (turn.role !== 'user') continue
    const stripped = stripReminders(turn.content).trim()
    if (stripped.length === 0) continue
    texts.push(stripped)
  }
  return texts
}

function stripReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

function looksLikeFollowUp(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return true
  if (t.length <= FOLLOW_UP_MAX_CHARS && FOLLOW_UP_RE.test(t)) return true
  return false
}

function looksLikeNewTask(text: string): boolean {
  return NEW_TASK_HINT_RE.test(text)
}

/**
 * MVP：本 parser 只收单任务。第二轮像新任务、或无法高置信判成跟进，一律拒。
 * 不看 gitBranch / commit。
 */
function rejectIfMultiTaskAmbiguous(turns: RawTurn[]): void {
  const humans = humanUserTexts(turns)
  if (humans.length <= 1) return
  for (const text of humans.slice(1)) {
    if (looksLikeFollowUp(text) && !looksLikeNewTask(text)) continue
    throw new AdmissionError(
      'multi_task_ambiguous',
      'session has another user instruction that looks like a new task; split confidence is too low (not splitting by git commit)',
    )
  }
}

function parseArgs(args_json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args_json)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isTestLikeCall(turn: RawTurn): boolean {
  if (turn.role !== 'tool_call' || turn.tool === undefined) return false
  const name = turn.tool.name.toLowerCase()
  if (name === 'test' || name === 'pytest' || name === 'jest' || name === 'vitest') return true
  if (!TEST_TOOL_NAMES.has(name)) return false
  const args = parseArgs(turn.tool.args_json)
  const command = typeof args.command === 'string' ? args.command : ''
  return TEST_COMMAND_RE.test(command)
}

function parseExitCode(content: string, args_json: string | undefined): number | undefined {
  const tagged = content.match(/<exit_code>\s*(-?\d+)\s*<\/exit_code>/iu)
  if (tagged?.[1] !== undefined) return Number(tagged[1])
  const labeled = content.match(/\bexit(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/iu)
  if (labeled?.[1] !== undefined) return Number(labeled[1])
  const paren = content.match(/\(exit\s+(-?\d+)\)/iu)
  if (paren?.[1] !== undefined) return Number(paren[1])
  if (args_json !== undefined) {
    const args = parseArgs(args_json)
    if (typeof args.exitCode === 'number') return args.exitCode
    if (args.is_error === true) return 1
  }
  return undefined
}

function isSuccessfulTestResult(content: string, args_json: string | undefined): boolean {
  const exit = parseExitCode(content, args_json)
  if (exit !== undefined) return exit === 0
  if (/\b(FAIL|FAILED|failures?:?\s*[1-9])/iu.test(content) && !/\b0 failed\b/iu.test(content)) {
    return false
  }
  return /\bPASS(?:ED)?\b/u.test(content) || /\b\d+\s+passed\b/iu.test(content)
}

function inferLastSuccessfulTest(turns: RawTurn[]): GroundTruth | undefined {
  let last: { result: RawTurn; call?: RawTurn } | undefined
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn === undefined || turn.role !== 'tool_call' || !isTestLikeCall(turn)) continue
    const result = findMatchingResult(turns, i)
    if (result === undefined) continue
    if (isSuccessfulTestResult(result.content, result.tool?.args_json)) {
      last = { result, call: turn }
    }
  }
  if (last === undefined) return undefined
  return {
    kind: 'tests_passed',
    evidence_ref: `turn:${last.result.id}`,
  }
}

function findMatchingResult(turns: RawTurn[], callIndex: number): RawTurn | undefined {
  const call = turns[callIndex]
  if (call === undefined) return undefined
  for (let j = callIndex + 1; j < turns.length; j++) {
    const cand = turns[j]
    if (cand === undefined) continue
    if (cand.role === 'tool_result') return cand
    if (cand.role === 'tool_call') return undefined
  }
  return undefined
}

function resolveEvidenceTurnId(
  turns: RawTurn[],
  gt: GroundTruth,
  inferred: GroundTruth | undefined,
): string | undefined {
  const ref = gt.evidence_ref
  const turnPrefixed = /^turn:(.+)$/u.exec(ref)
  if (turnPrefixed?.[1] !== undefined && turns.some((t) => t.id === turnPrefixed[1])) {
    return turnPrefixed[1]
  }
  const byId = turns.find((t) => t.id === ref)
  if (byId !== undefined) return byId.id
  const containing = [...turns].reverse().find((t) => t.content.includes(ref))
  if (containing !== undefined) return containing.id
  if (inferred !== undefined) {
    const inferredId = /^turn:(.+)$/u.exec(inferred.evidence_ref)?.[1]
    if (inferredId !== undefined) return inferredId
  }
  return undefined
}

interface ActionUnit {
  ids: string[]
  start: number
  end: number
}

function groupActionUnits(turns: RawTurn[]): ActionUnit[] {
  const units: ActionUnit[] = []
  let i = 0
  while (i < turns.length) {
    const turn = turns[i]
    if (turn === undefined) break
    if (turn.role === 'user') {
      i += 1
      continue
    }
    const start = i
    const ids: string[] = []
    while (i < turns.length && turns[i]?.role === 'thought') {
      const thought = turns[i]
      if (thought !== undefined) ids.push(thought.id)
      i += 1
    }
    const maybeCall = turns[i]
    if (maybeCall?.role === 'tool_call') {
      ids.push(maybeCall.id)
      i += 1
      const maybeResult = turns[i]
      if (maybeResult?.role === 'tool_result') {
        ids.push(maybeResult.id)
        i += 1
      }
      units.push({ ids, start, end: i - 1 })
      continue
    }
    if (maybeCall?.role === 'assistant') {
      ids.push(maybeCall.id)
      i += 1
      units.push({ ids, start, end: i - 1 })
      continue
    }
    if (ids.length > 0) {
      units.push({ ids, start, end: i - 1 })
      continue
    }
    ids.push(turn.id)
    i += 1
    units.push({ ids, start, end: i - 1 })
  }
  return units
}

function buildAnchorTurnIds(turns: RawTurn[], evidenceTurnId: string | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (id: string | undefined): void => {
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }

  const firstUser = turns.find((t) => t.role === 'user')
  push(firstUser?.id)
  if (firstUser !== undefined) {
    const idx = turns.findIndex((t) => t.id === firstUser.id)
    push(turns[idx + 1]?.id)
  }

  if (evidenceTurnId !== undefined) {
    const units = groupActionUnits(turns)
    const evIndex = turns.findIndex((t) => t.id === evidenceTurnId)
    if (evIndex >= 0) {
      const auIndex = units.findIndex((u) => u.start <= evIndex && u.end >= evIndex)
      if (auIndex >= 0) {
        const lo = Math.max(0, auIndex - GT_NEIGHBOR_AU_RADIUS)
        const hi = Math.min(units.length - 1, auIndex + GT_NEIGHBOR_AU_RADIUS)
        for (let u = lo; u <= hi; u++) {
          const unit = units[u]
          if (unit === undefined) continue
          for (const id of unit.ids) push(id)
        }
      } else {
        push(evidenceTurnId)
        for (let d = 1; d <= GT_NEIGHBOR_AU_RADIUS; d++) {
          push(turns[evIndex - d]?.id)
          push(turns[evIndex + d]?.id)
        }
      }
    }
  }

  return out
}

/**
 * OPEN: ingest 开放问题 4。哈希输入 = source + sessionId + 规范化 JSONL 记录。
 * 原料自带 trace_id / sessionId 优先；禁止随机 UUID。
 */
function resolveTraceId(
  explicitId: string | undefined,
  sessionId: string | undefined,
  records: unknown[],
): string {
  if (explicitId !== undefined && explicitId.length > 0) return explicitId
  if (sessionId !== undefined && sessionId.length > 0) return `claude-code:${sessionId}`
  const canonical = JSON.stringify(records)
  return `claude-code:${stableHash(canonical)}`
}
