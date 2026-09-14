/**
 * Hole-tool registry (ADR-0016): sole dispatch entry for sessions / cut-brain /
 * sparse_intent / L4 hole-tool calls. Executors are extension handlers.
 * pi customTools execute goes through ackHoleTool (ACK + mask).
 * Closed set LOCKED: label_segment / check_continuity / keep_segment /
 * read_segment / apply_rules_hint. Forbidden: edit_trace / drop_segment.
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
import { formatMaskedForPrompt, maskToolResult } from '../prompt/tool_mask.ts'

export type { HoleToolName }

export interface HoleToolDispatchContext {
  windowIds?: ReadonlySet<string>
  read?: HoleReadContext
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

export function isHoleToolName(name: string): name is HoleToolName {
  return (HOLE_TOOL_NAMES as readonly string[]).includes(name)
}

/** ACK + mask for pi customTools execute / prompt re-injection (ADR-0010). */
export function ackHoleTool(toolName: string, payload: unknown): HoleToolAck {
  const masked = maskToolResult(payload, { toolName })
  return {
    content: [{ type: 'text', text: formatMaskedForPrompt(masked) }],
    details: { ok: true as const, masked: true as const },
  }
}

/**
 * Dispatch a closed-set hole tool to extension handlers.
 * Sessions must call this instead of handlers or ad-hoc defineTool.
 */
export function executeHoleTool(
  name: string,
  args: unknown,
  ctx: HoleToolDispatchContext = {},
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
