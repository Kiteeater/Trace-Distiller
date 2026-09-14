import { AGENT_ROLES, type AgentRole } from '../enums/agent_role.ts'

/** Thin live/session progress only. Never carry tool args/results/evidence text. */
export const THIN_SESSION_EVENT_KINDS = [
  'turn_start',
  'turn_end',
  'tool_start',
  'tool_end',
  'usage',
] as const

export type ThinSessionEventKind = (typeof THIN_SESSION_EVENT_KINDS)[number]

export interface ThinSessionEvent {
  role: AgentRole
  /** 1-based prompt/turn counter for this handle */
  round: number
  kind: ThinSessionEventKind
  /** Tool name only (no args/result). */
  tool_name?: string
  input_tokens_delta?: number
  output_tokens_delta?: number
  is_error?: boolean
}

/** Keys that must never appear on a thin event (or nested objects). */
export const THIN_SESSION_EVENT_FORBIDDEN_KEYS = [
  'args',
  'result',
  'partialResult',
  'messages',
  'text',
  'evidence',
  'content',
  'tool_calls',
] as const

export function thinEventHasForbiddenPayload(e: unknown): boolean {
  return valueHasForbiddenThinKey(e)
}

function valueHasForbiddenThinKey(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.some(valueHasForbiddenThinKey)
  const rec = value as Record<string, unknown>
  for (const key of THIN_SESSION_EVENT_FORBIDDEN_KEYS) {
    if (Object.hasOwn(rec, key)) return true
  }
  for (const nested of Object.values(rec)) {
    if (valueHasForbiddenThinKey(nested)) return true
  }
  return false
}

export function assertThinSessionEvent(e: unknown): asserts e is ThinSessionEvent {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) {
    throw new Error('thin session event must be an object')
  }
  if (thinEventHasForbiddenPayload(e)) {
    throw new Error('thin session event carries forbidden payload keys')
  }
  const rec = e as Record<string, unknown>
  if (typeof rec.role !== 'string' || !(AGENT_ROLES as readonly string[]).includes(rec.role)) {
    throw new Error('thin session event missing role')
  }
  if (typeof rec.round !== 'number' || !Number.isInteger(rec.round) || rec.round < 1) {
    throw new Error('thin session event round must be 1-based')
  }
  if (typeof rec.kind !== 'string' || !(THIN_SESSION_EVENT_KINDS as readonly string[]).includes(rec.kind)) {
    throw new Error('thin session event unknown kind')
  }
  if (rec.tool_name !== undefined && typeof rec.tool_name !== 'string') {
    throw new Error('thin session event tool_name must be a string')
  }
}

/** Drop any extra keys so emit never forwards args/result/text. */
export function sanitizeThinSessionEvent(e: ThinSessionEvent): ThinSessionEvent {
  const out: ThinSessionEvent = { role: e.role, round: e.round, kind: e.kind }
  if (e.tool_name !== undefined) out.tool_name = e.tool_name
  if (e.input_tokens_delta !== undefined) out.input_tokens_delta = e.input_tokens_delta
  if (e.output_tokens_delta !== undefined) out.output_tokens_delta = e.output_tokens_delta
  if (e.is_error !== undefined) out.is_error = e.is_error
  return out
}
