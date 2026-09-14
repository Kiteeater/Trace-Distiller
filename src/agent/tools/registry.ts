/**
 * Hole-tool registry (ADR-0016): sole dispatch entry for sessions / cut-brain /
 * sparse_intent / L4 hole-tool calls. Executors are extension handlers.
 * pi customTools execute goes through ackHoleTool (ACK + mask).
 * Closed set LOCKED: label_segment / check_continuity / keep_segment /
 * read_segment / apply_rules_hint. Forbidden: edit_trace / drop_segment.
 *
 * Distiller-owned `beforeDispatch` / `afterDispatch` wrap this registry only.
 * They are **not** pi Extension `on(...)` hooks and must not rewrite
 * `systemPrompt` / `system_prompt` or mutate session state.
 */
import {
  HOLE_TOOL_NAMES,
  handleApplyRulesHint,
  handleCheckContinuity,
  handleKeepSegment,
  handleLabelSegment,
  handleReadSegment,
  type ApplyRulesHintAccepted,
  type ContinuityAccepted,
  type HoleReadContext,
  type HoleToolName,
  type KeepSegmentAccepted,
  type LabelSegmentAccepted,
  type ReadSegmentAccepted,
} from '../extension.ts'
import { assertAckOrMaskedToolMessage, formatMaskedForPrompt, maskToolResult } from '../prompt/tool_mask.ts'

export type { HoleToolName }

export interface HoleToolDispatchContext {
  windowIds?: ReadonlySet<string>
  read?: HoleReadContext
}

/**
 * Optional focus=1 / single-id / window constraints for Distiller
 * `beforeDispatch` (registry layer, not pi Extension).
 */
export interface HoleToolHookContext extends HoleToolDispatchContext {
  /** When set, judgment/read tools that carry segment_id must equal this id (ADR-0012 focus=1). */
  focusId?: string
  /**
   * When true (default when focusId is set), refuse args that address more than one
   * segment id in one dispatch (single-id constraint).
   */
  requireSingleId?: boolean
}

export type HoleToolDispatchOk =
  | { ok: true; name: 'label_segment'; accepted: LabelSegmentAccepted }
  | { ok: true; name: 'check_continuity'; accepted: ContinuityAccepted }
  | { ok: true; name: 'keep_segment'; accepted: KeepSegmentAccepted }
  | { ok: true; name: 'read_segment'; accepted: ReadSegmentAccepted }
  | { ok: true; name: 'apply_rules_hint'; accepted: ApplyRulesHintAccepted }

export interface HoleToolDispatchErr {
  ok: false
  name: string
  error: string
}

export type HoleToolDispatchResult = HoleToolDispatchOk | HoleToolDispatchErr

export interface HoleToolAck {
  content: Array<{ type: 'text'; text: string }>
  details: { ok: true; masked: true }
}

/**
 * Distiller registry before-hook. Return `HoleToolDispatchErr` to refuse
 * without calling handlers. Must not rewrite systemPrompt.
 */
export type BeforeDispatchHook = (
  name: string,
  args: unknown,
  ctx: HoleToolHookContext,
) => void | HoleToolDispatchErr

/**
 * Distiller registry after-hook. When `promptText` / `ack` is provided, the
 * default hook asserts ACK / masked shape. Must not rewrite systemPrompt.
 */
export type AfterDispatchHook = (info: {
  name: string
  args: unknown
  ctx: HoleToolHookContext
  /** Structured dispatch result from executeHoleTool (handlers). */
  dispatch?: HoleToolDispatchResult
  /**
   * Prompt-facing text about to re-enter the agent turn (ACK / masked summary).
   * afterDispatch MUST call assertAckOrMaskedToolMessage when this is provided.
   */
  promptText?: string
  /** ackHoleTool return value when applicable. */
  ack?: HoleToolAck
}) => void

/** Distiller registry hooks — not a pi Extension `on` chain. */
export interface RegistryHooks {
  beforeDispatch?: BeforeDispatchHook
  afterDispatch?: AfterDispatchHook
}

const SINGLE_SEGMENT_TOOLS = new Set<string>(['label_segment', 'keep_segment', 'read_segment'])

export function isHoleToolName(name: string): name is HoleToolName {
  return (HOLE_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * Default Distiller before-hook: refuse unknown / forbidden names; when
 * context provides focus=1 or window ids, refuse out-of-slot single-id tools.
 * Does not rewrite systemPrompt. Not a pi Extension hook.
 */
export function defaultBeforeDispatch(
  name: string,
  args: unknown,
  ctx: HoleToolHookContext,
): void | HoleToolDispatchErr {
  if (!isHoleToolName(name)) {
    return { ok: false, name, error: `unknown hole tool: ${name}` }
  }
  const rec = asRecord(args)
  const segmentId = rec !== undefined ? stringId(rec.segment_id) : undefined
  const enforceSingle =
    ctx.requireSingleId === true || (ctx.focusId !== undefined && ctx.requireSingleId !== false)

  if (!SINGLE_SEGMENT_TOOLS.has(name)) {
    return
  }

  if (ctx.focusId !== undefined && segmentId !== undefined && segmentId !== ctx.focusId) {
    return {
      ok: false,
      name,
      error: `focus=1: ${name} segment_id '${segmentId}' !== focusId '${ctx.focusId}'`,
    }
  }
  if (ctx.windowIds !== undefined && segmentId !== undefined && !ctx.windowIds.has(segmentId)) {
    return { ok: false, name, error: `${name} unknown segment_id` }
  }
  if (enforceSingle && rec !== undefined && listsMultipleTargetIds(rec)) {
    return {
      ok: false,
      name,
      error: `focus=1: ${name} refuses multiple target ids in one dispatch`,
    }
  }
  return
}

/**
 * Default Distiller after-hook: enforce ACK / masked prompt shape at the
 * registry boundary. Structured `dispatch.accepted` payloads are internal and
 * are not required to be ACK strings. Does not rewrite systemPrompt.
 */
export function defaultAfterDispatch(info: Parameters<AfterDispatchHook>[0]): void {
  if (info.promptText !== undefined) {
    assertAckOrMaskedToolMessage(info.promptText)
  }
  if (info.ack !== undefined) {
    for (const part of info.ack.content) {
      assertAckOrMaskedToolMessage(part.text)
    }
  }
}

const DEFAULT_REGISTRY_HOOKS: RegistryHooks = {
  beforeDispatch: defaultBeforeDispatch,
  afterDispatch: defaultAfterDispatch,
}

let registryHooks: RegistryHooks = { ...DEFAULT_REGISTRY_HOOKS }

/** Replace Distiller registry hooks. `undefined` restores defaults. Pass `{}` to clear. */
export function setRegistryHooks(hooks?: RegistryHooks): void {
  registryHooks = hooks === undefined ? { ...DEFAULT_REGISTRY_HOOKS } : { ...hooks }
}

export function getRegistryHooks(): RegistryHooks {
  return registryHooks
}

/** Restore Distiller default before/after hooks (tests). */
export function resetRegistryHooks(): void {
  registryHooks = { ...DEFAULT_REGISTRY_HOOKS }
}

/** ACK + mask for pi customTools execute / prompt re-injection (ADR-0010). */
export function ackHoleTool(
  toolName: string,
  payload: unknown,
  ctx: HoleToolHookContext = {},
): HoleToolAck {
  const before = registryHooks.beforeDispatch?.(toolName, payload, ctx)
  if (before !== undefined && before.ok === false) {
    throw new Error(before.error)
  }
  const masked = maskToolResult(payload, { toolName })
  const promptText = formatMaskedForPrompt(masked)
  const ack: HoleToolAck = {
    content: [{ type: 'text', text: promptText }],
    details: { ok: true as const, masked: true as const },
  }
  registryHooks.afterDispatch?.({ name: toolName, args: payload, ctx, ack, promptText })
  return ack
}

/**
 * Dispatch a closed-set hole tool to extension handlers.
 * Sessions must call this instead of handlers or ad-hoc defineTool.
 * Distiller `beforeDispatch` / `afterDispatch` wrap this entry (not pi Extension).
 */
export function executeHoleTool(
  name: string,
  args: unknown,
  ctx: HoleToolHookContext = {},
): HoleToolDispatchResult {
  const before = registryHooks.beforeDispatch?.(name, args, ctx)
  if (before !== undefined && before.ok === false) {
    return before
  }
  const result = dispatchHoleTool(name, args, ctx)
  registryHooks.afterDispatch?.({ name, args, ctx, dispatch: result })
  return result
}

function dispatchHoleTool(
  name: string,
  args: unknown,
  ctx: HoleToolHookContext,
): HoleToolDispatchResult {
  if (!isHoleToolName(name)) {
    return { ok: false, name, error: `unknown hole tool: ${name}` }
  }
  switch (name) {
    case 'label_segment': {
      const handled = handleLabelSegment(args, ctx.windowIds)
      if (!handled.ok) return { ok: false, name, error: handled.error }
      return {
        ok: true,
        name,
        accepted: {
          segment_id: handled.segment_id,
          label: handled.label,
          confidence: handled.confidence,
          keep_bits: handled.keep_bits,
        },
      }
    }
    case 'check_continuity': {
      const handled = handleCheckContinuity(args)
      if (!handled.ok) return { ok: false, name, error: handled.error }
      return {
        ok: true,
        name,
        accepted: {
          left_id: handled.left_id,
          right_id: handled.right_id,
          reachable: handled.reachable,
          score: handled.score,
          reason: handled.reason,
        },
      }
    }
    case 'keep_segment': {
      const handled = handleKeepSegment(args, ctx.windowIds)
      if (!handled.ok) return { ok: false, name, error: handled.error }
      return {
        ok: true,
        name,
        accepted: {
          segment_id: handled.segment_id,
          confidence: handled.confidence,
          keep_bits: handled.keep_bits,
        },
      }
    }
    case 'read_segment': {
      if (ctx.read === undefined) {
        return { ok: false, name, error: 'read_segment requires read context' }
      }
      const handled = handleReadSegment(ctx.read, args)
      if (!handled.ok) return { ok: false, name, error: handled.error }
      return {
        ok: true,
        name,
        accepted: {
          segment_id: handled.segment_id,
          focus: handled.focus,
          text: handled.text,
        },
      }
    }
    case 'apply_rules_hint': {
      const handled = handleApplyRulesHint(args)
      if (!handled.ok) return { ok: false, name, error: handled.error }
      return { ok: true, name, accepted: { scope: handled.scope } }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function listsMultipleTargetIds(rec: Record<string, unknown>): boolean {
  if (Array.isArray(rec.segment_id) && rec.segment_id.filter((x) => typeof x === 'string').length > 1) {
    return true
  }
  if (Array.isArray(rec.segment_ids) && rec.segment_ids.filter((x) => typeof x === 'string').length > 1) {
    return true
  }
  const primary = stringId(rec.segment_id)
  if (primary !== undefined && Array.isArray(rec.segment_ids)) {
    const extras = rec.segment_ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    if (extras.some((id) => id !== primary) || extras.length > 1) return true
  }
  return false
}
