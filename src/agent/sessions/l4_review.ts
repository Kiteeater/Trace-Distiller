import type { AgentRole } from '../../enums/agent_role.ts'
import type { IntentHypothesis } from '../../types/agent_view.ts'
import type { PlaybackCut } from '../../types/cut_plan.ts'
import { TRACE_DATA_NOTICE, type TokenUsage } from './skeleton_pass.ts'
import {
  L4_REVIEW_JSON_KIND,
  composeSessionPrompt,
  formatMarkedJson,
  openReviewSession,
  parseStructuredJson,
  playbackIndexForL4,
  type SessionBackend,
  type SessionPromptInput,
  type SessionPromptResult,
} from './open_session.ts'

export { L4_REVIEW_JSON_KIND }

const BLIND_CONTRABAND = /\b(?:warrant|skeleton)\b/i

export interface RunBlindReviewInput {
  intent: IntentHypothesis
  playback: PlaybackCut
  backend?: SessionBackend
}

export interface ReviewAnswer {
  turning_point_segment_ids: string[]
  evidence_segment_ids: string[]
  free_text?: string
}

export interface RunBlindReviewOutput {
  answer: ReviewAnswer
  usage: TokenUsage
}

/**
 * L4 盲测 review 会话。role=l4_review。
 * 只注入 intent + playback。禁止 warrant / skeleton（ADR-0009）。
 * 答卷结构化；自由文本不判分。L4 token 不计蒸馏成本。
 */
export async function runBlindReview(input: RunBlindReviewInput): Promise<RunBlindReviewOutput> {
  const session = openReviewSession({
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
  })
  try {
    const prompt = composeReviewPrompt(input)
    assertBlindReviewPrompt(composeSessionPrompt(prompt))
    const result = await session.prompt(prompt)
    return interpretReviewResult(result, session.role)
  } finally {
    session.dispose()
  }
}

export function composeReviewPrompt(input: RunBlindReviewInput): SessionPromptInput {
  const intent: Record<string, unknown> = {
    version: input.intent.version,
    text: input.intent.text,
  }
  if (input.intent.scenario !== undefined) intent.scenario = input.intent.scenario
  const text = [
    TRACE_DATA_NOTICE,
    'Blind review: you receive only the task intent and the cut playback.',
    'Name turning-point and evidence segment ids you can see. Output JSON only.',
    formatMarkedJson('INTENT_JSON', intent),
    formatMarkedJson('PLAYBACK_JSON', playbackIndexForL4(input.playback)),
    [
      'Reply with JSON only, matching this schema:',
      JSON.stringify({
        kind: L4_REVIEW_JSON_KIND,
        turning_point_segment_ids: ['string'],
        evidence_segment_ids: ['string'],
        free_text: 'string',
      }),
    ].join('\n'),
  ].join('\n\n')
  return {
    system:
      'You are a blind reviewer. You see only intent and playback. Do not assume hidden cut notes exist.',
    text,
  }
}

/** 工厂防线：review 消息不得出现 warrant / skeleton。 */
export function assertBlindReviewPrompt(composed: string): void {
  if (BLIND_CONTRABAND.test(composed)) {
    throw new Error('review session must not include warrant or skeleton')
  }
}

export function interpretReviewResult(
  result: SessionPromptResult,
  role: AgentRole,
): RunBlindReviewOutput {
  const payload = result.json ?? parseJsonOrThrow(result.text, 'runBlindReview')
  const rec = asRecord(payload)
  if (rec === undefined) throw new Error('runBlindReview: expected a JSON object')
  if (rec.kind !== undefined && rec.kind !== L4_REVIEW_JSON_KIND) {
    throw new Error(`runBlindReview: unexpected kind ${String(rec.kind)}`)
  }
  const answer: ReviewAnswer = {
    turning_point_segment_ids: stringIdList(rec.turning_point_segment_ids),
    evidence_segment_ids: stringIdList(rec.evidence_segment_ids),
  }
  if (typeof rec.free_text === 'string' && rec.free_text.length > 0) {
    answer.free_text = rec.free_text
  }
  return {
    answer,
    usage: {
      role,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  }
}

function stringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function parseJsonOrThrow(text: string, label: string): unknown {
  try {
    return parseStructuredJson(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON'
    throw new Error(`${label}: failed to parse structured JSON (${message})`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
