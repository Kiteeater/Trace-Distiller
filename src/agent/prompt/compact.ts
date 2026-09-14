/**
 * Distiller-owned prune of agent-visible prompt history (ADR-0012 / ADR-0016).
 * Drops older ACK / masked-card / tool_calls rounds at prompt assembly only.
 * Does not mutate store/warrant. Does not call pi compact or any LLM summarizer.
 */
import { PROMPT_HISTORY_RECENT_ROUNDS } from '../../constant/window.ts'
import type { SessionMessage } from './compose.ts'
import { isMaskedToolSummary, looksLikeRawToolPayload } from './tool_mask.ts'

export interface PrunePromptHistoryOpts {
  /** Default: PROMPT_HISTORY_RECENT_ROUNDS */
  recentRounds?: number
}

/**
 * Prune agent-visible message history for the next prompt (ADR-0012).
 * Keeps the last `recentRounds` of ACK / masked-card rounds; drops older
 * evidence / MASKED_TOOL_RESULTS / tool_calls chatter from the returned array.
 * Does not mutate `messages`. Does not touch store/warrant. Never calls LLM.
 *
 * Round heuristic (stable, testable):
 * - Prefer grouping as assistant+user pairs when present (sparse_intent pattern:
 *   assistant `tool_calls: …` then user `MASKED_TOOL_RESULTS…` / ACK…).
 * - Lone user ACK / masked / MASKED_TOOL_RESULTS messages each count as one round
 *   (cut-brain lastAck pattern).
 * - Non-round pointer-like messages are kept only when the whole history already
 *   fits in N rounds (shallow copy). Otherwise only the last N rounds are kept;
 *   older evidence and older non-round chatter are dropped.
 *
 * `recentRounds <= 0` returns `[]` (all messages treated as droppable history).
 */
export function prunePromptHistory(
  messages: readonly SessionMessage[],
  opts?: PrunePromptHistoryOpts,
): SessionMessage[] {
  const recentRounds = opts?.recentRounds ?? PROMPT_HISTORY_RECENT_ROUNDS
  if (recentRounds <= 0) return []
  if (messages.length === 0) return []

  const rounds = groupAckMaskedRounds(messages)
  if (rounds.length <= recentRounds) return messages.slice()

  const kept = rounds.slice(-recentRounds)
  const out: SessionMessage[] = []
  for (const round of kept) out.push(...round)
  return out
}

/**
 * True if this message looks like ACK / masked card / tool_calls round content
 * (i.e. agent-visible evidence history subject to prune).
 */
export function isAckOrMaskedRoundMessage(msg: SessionMessage): boolean {
  const content = msg.content
  if (startsWithAck(content) || content.includes('ACK card_id=')) return true
  if (content.includes('MASKED_TOOL_RESULTS')) return true
  if (isMaskedToolSummary(content)) return true
  if (isToolCallsLine(content)) return true
  if (/\btext_chars\b/.test(content)) return true
  if (looksLikeRawToolPayload(content)) return true
  return false
}

function groupAckMaskedRounds(messages: readonly SessionMessage[]): SessionMessage[][] {
  const rounds: SessionMessage[][] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg === undefined) break
    const next = messages[i + 1]
    if (
      msg.role === 'assistant' &&
      isToolCallsLine(msg.content) &&
      next !== undefined &&
      next.role === 'user' &&
      isAckOrMaskedRoundMessage(next)
    ) {
      rounds.push([msg, next])
      i += 2
      continue
    }
    if (isAckOrMaskedRoundMessage(msg)) {
      rounds.push([msg])
      i += 1
      continue
    }
    i += 1
  }
  return rounds
}

function startsWithAck(content: string): boolean {
  return /^ACK\b/.test(content.trim())
}

function isToolCallsLine(content: string): boolean {
  return /^\s*tool_calls:/.test(content)
}
