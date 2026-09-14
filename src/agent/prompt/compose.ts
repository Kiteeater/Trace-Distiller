/**
 * Session prompt composer (ADR-0016).
 * KV-cache order: stable prefix → session state pointers → unstable evidence.
 * Unstable user / evidence must not enter the stable prefix.
 * Large payloads are masked via tool_mask (ADR-0010/0012).
 */
import {
  formatMaskedForPrompt,
  isMaskedToolSummary,
  looksLikeRawToolPayload,
  maskToolResult,
  parseJsonIfStructured,
  TOOL_MASK_DEFAULT_MAX_CHARS,
} from './tool_mask.ts'

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface SessionPromptInput {
  text: string
  system?: string
  skill_text?: string
  /** Compact skeleton pointer text — state layer, not a giant blob. */
  skeleton_text?: string
  /** Compact session state pointers (card_index / focus) — not giant blobs. */
  state_pointers?: string
  messages?: readonly SessionMessage[]
}

function nonEmpty(part: string | undefined): part is string {
  return typeof part === 'string' && part.length > 0
}

/**
 * Compose a session prompt in stable → state-pointer → unstable order.
 * `system` + `skill_text` form the stable prefix; `skeleton_text` /
 * `state_pointers` are compact session state; messages + `text` are unstable
 * (prior turns, user text, evidence). Messages that look like tool payloads
 * go through maskPromptMessageContent.
 */
export function composeSessionPrompt(input: SessionPromptInput): string {
  const chunks: string[] = []
  const stable = [input.system, input.skill_text].filter(nonEmpty)
  if (stable.length > 0) chunks.push(stable.join('\n\n'))
  const state = [input.skeleton_text, input.state_pointers].filter(nonEmpty)
  if (state.length > 0) chunks.push(state.join('\n\n'))
  for (const msg of input.messages ?? []) {
    const content = maskPromptMessageContent(msg.content)
    chunks.push(`${msg.role}:\n${content}`)
  }
  chunks.push(input.text)
  return chunks.join('\n\n')
}

/**
 * Mask tool-like blobs before they re-enter a session prompt (ADR-0010/0012).
 * ACK / short human status / already-masked summaries pass through.
 * Raw tool JSON (even ≤480 chars) is forced through maskToolResult.
 */
export function maskPromptMessageContent(content: string): string {
  const trimmed = content.trim()
  if (/^ACK\b/.test(trimmed)) return content
  if (isMaskedToolSummary(trimmed)) return content
  if (looksLikeRawToolPayload(content)) {
    const parsed = parseJsonIfStructured(content)
    return formatMaskedForPrompt(maskToolResult(parsed ?? content))
  }
  if (content.length <= TOOL_MASK_DEFAULT_MAX_CHARS) return content
  return formatMaskedForPrompt(maskToolResult(content))
}
