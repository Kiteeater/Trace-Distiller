/**
 * Shim (ADR-0016): tool_mask lives in `src/agent/prompt/tool_mask.ts`
 * (prompt-layer masking of large payloads). Re-export for old imports.
 */
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
} from '../prompt/tool_mask.ts'
export type { MaskToolResultOpts, MaskedToolResult } from '../prompt/tool_mask.ts'
