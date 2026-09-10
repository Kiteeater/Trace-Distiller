import { defineTool, type ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import { LABELS } from '../../enums/label.ts'
import { HOLE_TOOL_NAMES, type HoleToolName } from '../extension.ts'

const LABEL_ENUM = Type.Union(LABELS.map((v) => Type.Literal(v)))

function ack(text: string): { content: Array<{ type: 'text'; text: string }>; details: { ok: true } } {
  return { content: [{ type: 'text', text }], details: { ok: true as const } }
}

/** pi customTools 闭集；execute 只 ACK，编排器事后从 messages 抽 tool_calls 再跑 extension handlers。 */
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
          'Assign a four-class Label to one unresolved segment_id in the current window.',
        promptSnippet: 'Label one window segment with key_decision|useful_exploration|dead_end|routine',
        promptGuidelines: [
          'Call label_segment once per unresolved segment_id you decide on.',
          'Do not invent segment ids outside window_segment_ids.',
        ],
        parameters: Type.Object({
          segment_id: Type.String({ description: 'Segment id in the current window' }),
          label: LABEL_ENUM,
          confidence: Type.Number({ description: 'Confidence in [0, 1]' }),
        }),
        async execute(_toolCallId, params) {
          return ack(
            `recorded label_segment ${params.segment_id}=${String(params.label)}@${String(params.confidence)}`,
          )
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
          return ack(
            `recorded check_continuity ${params.left_id}->${params.right_id} score=${String(params.score)}`,
          )
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
          'Fetch full text for one segment_id in the current window only. Prefer WINDOW_CARDS when enough.',
        promptSnippet: 'Read one window segment raw text',
        parameters: Type.Object({
          segment_id: Type.String({ description: 'Segment id in the current window' }),
        }),
        async execute(_toolCallId, params) {
          return ack(
            `read_segment acknowledged for ${params.segment_id}; use WINDOW_CARDS/head when full text is not injected`,
          )
        },
      }),
    )
  }

  return out
}

export interface PiToolRegistration {
  tools: string[]
  customTools?: ToolDefinition[]
  noTools: 'all' | 'builtin'
}

/** 映射 openSession tools → createAgentSession 的 tools/customTools/noTools。 */
export function resolvePiToolRegistration(requested: readonly string[]): PiToolRegistration {
  if (requested.length === 0) {
    return { tools: [], noTools: 'all' }
  }
  const customTools = buildHoleCustomTools(requested)
  const tools = customTools.map((t) => t.name)
  return {
    tools,
    customTools,
    noTools: 'builtin',
  }
}
