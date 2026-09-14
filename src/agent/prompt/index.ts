/**
 * Prompt layer (ADR-0016): KV-friendly compose + large-payload mask.
 * sessions/ must call composeSessionPrompt here; do not duplicate compose logic.
 */
export {
  composeSessionPrompt,
  maskPromptMessageContent,
  type SessionMessage,
  type SessionPromptInput,
} from './compose.ts'
export {
  ACK_OR_MASKED_REQUIRED_MESSAGE,
  TOOL_MASK_DEFAULT_MAX_CHARS,
  assertAckOrMaskedToolMessage,
  formatMaskedForPrompt,
  isMaskedToolSummary,
  looksLikeRawToolPayload,
  looksLikeToolResultValue,
  maskToolResult,
  parseJsonIfStructured,
  type MaskToolResultOpts,
  type MaskedToolResult,
} from './tool_mask.ts'
