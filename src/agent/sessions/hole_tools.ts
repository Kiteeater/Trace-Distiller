import { defineTool, type ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { LABELS } from '../../enums/label.ts'
import { HOLE_TOOL_NAMES, type HoleToolName } from '../extension.ts'
import { formatMaskedForPrompt, maskToolResult } from './tool_mask.ts'

const LABEL_ENUM = Type.Union(LABELS.map((v) => Type.Literal(v)))

function ack(
  toolName: string,
  payload: unknown,
): { content: Array<{ type: 'text'; text: string }>; details: { ok: true; masked: true } } {
  // ADR-0010: never return full tool payload to the next agent turn.
  const masked = maskToolResult(payload, { toolName })
  return {
    content: [{ type: 'text', text: formatMaskedForPrompt(masked) }],
    details: { ok: true as const, masked: true as const },
  }
}

/** pi customTools 闭集；execute 只 ACK（经 tool_mask），编排器事后从 messages 抽 tool_calls 再跑 extension handlers。 */
export function buildHoleCustomTools(
  requested: readonly string[],
): ToolDefinition[] {
  const want = new Set(requested.filter((n): n is HoleToolName =>
    (HOLE_TOOL_NAMES as readonly string[]).includes(n),
  ))
  const out: ToolDefinition[] = []

  if (want.has('label_segment')) {
    out.push(
      defineTool({
        name: 'label_segment',
        label: 'Label segment',
        description:
          'Assign a Label to the current single-slot focus_id (ADR-0012). keep requires keep_bits.',
        promptSnippet:
          'Label the current focus_id; keep needs keep_bits skeleton_hit|key_decision_flag',
        promptGuidelines: [
          'Call label_segment once for the current focus_id only (focus_slot=1).',
          'Do not invent segment ids. Do not label multiple ids in one turn.',
        ],
        parameters: Type.Object({
          segment_id: Type.String({ description: 'Current focus_id' }),
          label: LABEL_ENUM,
          confidence: Type.Number({ description: 'Confidence in [0, 1]' }),
          keep_bits: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal('skeleton_hit'), Type.Literal('key_decision_flag')]),
            ),
          ),
        }),
        async execute(_toolCallId, params) {
          return ack('label_segment', {
            segment_id: params.segment_id,
            label: params.label,
            confidence: params.confidence,
            keep_bits: params.keep_bits ?? [],
          })
        },
      }),
    )
  }

  if (want.has('check_continuity')) {
    out.push(
      defineTool({
        name: 'check_continuity',
        label: 'Check continuity',
        description: 'Score whether a later keep-path step is reachable from an earlier one (1–5).',
        promptSnippet: 'Score adjacent keep-path continuity 1–5',
        parameters: Type.Object({
          left_id: Type.String(),
          right_id: Type.String(),
          reachable: Type.Boolean(),
          score: Type.Integer({ minimum: 1, maximum: 5 }),
          reason: Type.String({ minLength: 1 }),
        }),
        async execute(_toolCallId, params) {
          return ack('check_continuity', {
            left_id: params.left_id,
            right_id: params.right_id,
            reachable: params.reachable,
            score: params.score,
            reason: params.reason,
          })
        },
      }),
    )
  }

  if (want.has('keep_segment')) {
    out.push(
      defineTool({
        name: 'keep_segment',
        label: 'Keep segment',
        description:
          'Explicitly keep the current focus_id (ADR-0012). Requires keep_bits skeleton_hit|key_decision_flag and confidence ≥ 0.5.',
        promptSnippet: 'Explicit keep for the current focus_id with keep_bits',
        promptGuidelines: [
          'Call keep_segment only for the current focus_id with at least one keep_bit.',
          'Illegal keep (missing bits / low confidence) is overridden to collapse_uncertain.',
        ],
        parameters: Type.Object({
          segment_id: Type.String({ description: 'Focus id to keep' }),
          confidence: Type.Optional(Type.Number({ description: 'Confidence in [0, 1]; default 1' })),
          keep_bits: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal('skeleton_hit'), Type.Literal('key_decision_flag')]),
            ),
          ),
        }),
        async execute(_toolCallId, params) {
          return ack('keep_segment', {
            segment_id: params.segment_id,
            confidence: params.confidence ?? 1,
            keep_bits: params.keep_bits ?? [],
          })
        },
      }),
    )
  }

  if (want.has('read_segment')) {
    out.push(
      defineTool({
        name: 'read_segment',
        label: 'Read segment',
        description:
          'Request one S2 evidence card for the current focus_id (structure|headtail|error). Result is ACK + card_id only; full text never re-enters the next turn (ADR-0010/0012).',
        promptSnippet: 'Disclose one evidence card: structure|headtail|error',
        parameters: Type.Object({
          segment_id: Type.String({ description: 'Current focus_id' }),
          kind: Type.Optional(
            Type.Union([
              Type.Literal('structure'),
              Type.Literal('headtail'),
              Type.Literal('error'),
            ]),
          ),
        }),
        async execute(_toolCallId, params) {
          return ack('read_segment', {
            segment_id: params.segment_id,
            kind: params.kind ?? 'structure',
            card_id: `s2:${params.segment_id}:${params.kind ?? 'structure'}`,
          })
        },
      }),
    )
  }

  if (want.has('apply_rules_hint')) {
    out.push(
      defineTool({
        name: 'apply_rules_hint',
        label: 'Apply rules hint',
        description:
          'Run deterministic L1 rules as an optional hint (ADR-0010). Returns a masked summary + unresolved ids. Calling this endorses adopting rule labels for resolved ids; unresolved still need label_segment or keep_segment.',
        promptSnippet: 'Optional rules hint → masked summary + unresolved ids',
        promptGuidelines: [
          'Call at most once early if you want rule heuristics applied.',
          'Do not treat rules as a silent product path; unresolved must still be labeled or kept explicitly.',
        ],
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          // Real applyRules runs in cut_brain when interpreting the tool call.
          return ack('apply_rules_hint', {
            kind: 'apply_rules_hint',
            applied: false,
            resolved_count: 0,
            unresolved_ids: [] as string[],
            summary: 'pending: cut-brain will apply rules',
          })
        },
      }),
    )
  }

  return out
}

/** L4 replay coding allowlist（builtin read/bash/edit/write）。洞 A/B 禁止同名。 */
export const L4_REPLAY_CODING_TOOLS = ['read', 'bash', 'edit', 'write'] as const

export interface PiToolRegistration {
  tools: string[]
  customTools?: ToolDefinition[]
  /** 省略时：按 tools allowlist 启用 builtin（L4 replay）。 */
  noTools?: 'all' | 'builtin'
}

/** 映射 openSession tools → createAgentSession 的 tools/customTools/noTools。 */
export function resolvePiToolRegistration(requested: readonly string[]): PiToolRegistration {
  if (requested.length === 0) {
    return { tools: [], noTools: 'all' }
  }
  const coding = requested.filter((n) =>
    (L4_REPLAY_CODING_TOOLS as readonly string[]).includes(n),
  )
  if (coding.length > 0 && coding.length === requested.length) {
    // Pure coding allowlist — enable those builtins; do not set noTools.
    return { tools: [...coding] }
  }
  const customTools = buildHoleCustomTools(requested)
  const tools = customTools.map((t) => t.name)
  return {
    tools,
    customTools,
    noTools: 'builtin',
  }
}
