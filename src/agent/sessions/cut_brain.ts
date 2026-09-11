import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CUT_BRAIN_TOOL_NAMES,
  handleApplyRulesHint,
  handleKeepSegment,
  handleLabelSegment,
  handleReadSegment,
  type HoleReadContext,
} from '../extension.ts'
import { CUT_BRAIN_MAX_ROUNDS, LABEL_WINDOW_SIZE } from '../../constant/window.ts'
import type { LabelDecision } from '../../domain/label_decision.ts'
import { applyRules, type RulesOutput } from '../../pipeline/rules.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../../types/agent_view.ts'
import type { RawTrace } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'
import {
  TRACE_DATA_NOTICE,
  cardIndexPayload,
  type TokenUsage,
} from './skeleton_pass.ts'
import {
  openSession,
  type SessionBackend,
  type SessionMessage,
  type SessionPromptResult,
  type SessionToolCall,
} from './open_session.ts'
import { formatMaskedForPrompt, maskToolResult } from './tool_mask.ts'

export interface CutBrainInput {
  /** Open segment ids the agent may label/keep (usually all view.segments). */
  segment_ids: string[]
  view: AgentView
  raw: RawTrace
  skeleton: Skeleton
  intent: IntentHypothesis
  skill_path: string
  skill_text?: string
  backend?: SessionBackend
  /** Override ReAct round cap (tests). */
  max_rounds?: number
}

export interface CutBrainOutput {
  decisions: LabelDecision[]
  still_unresolved: string[]
  /** View after optional apply_rules_hint (rep_of / focus). */
  view: AgentView
  usage: TokenUsage
  notes?: string[]
  /** True when agent called apply_rules_hint and rules were adopted. */
  rules_hint_applied: boolean
}

/**
 * ADR-0010 cut-brain：洞 A 之后的 editor-in-chief 打标会话。
 * ReAct：propose → tool_calls → mask → iterate（最多 CUT_BRAIN_MAX_ROUNDS）。
 * 规则仅当 agent 调用 apply_rules_hint 时采纳；未决须 label_segment 或 keep_segment。
 * 不强制 rules-first 合并进最终 decisions。
 */
export async function cutBrain(input: CutBrainInput): Promise<CutBrainOutput> {
  if (input.segment_ids.length === 0) {
    throw new Error('cutBrain: segment_ids is empty')
  }

  const skill_text = loadSkillText(input)
  const skill = skillSourceName(input.skill_path)
  const maxRounds = input.max_rounds ?? CUT_BRAIN_MAX_ROUNDS
  const openIds = new Set(input.segment_ids)
  const session = openSession({
    role: 'hole_b_label',
    tools: CUT_BRAIN_TOOL_NAMES,
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
  })

  let view = input.view
  let rulesHintApplied = false
  let rulesCache: RulesOutput | undefined
  const decisions = new Map<string, LabelDecision>()
  const notes: string[] = []
  let usage: TokenUsage = {
    role: session.role,
    input_tokens: 0,
    output_tokens: 0,
  }
  const messages: SessionMessage[] = []

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const unresolved = input.segment_ids.filter((id) => !decisions.has(id))
      if (unresolved.length === 0) break

      const windowIds = unresolved.slice(0, LABEL_WINDOW_SIZE)
      const cards = view.segments.filter((c) => openIds.has(c.id))
      let result: SessionPromptResult
      try {
        result = await session.prompt({
          system: [
            'You are the cut-brain editor-in-chief (ADR-0010).',
            'Decide how to cut by calling tools; do not invent labels in prose.',
            'Optional: call apply_rules_hint once to endorse deterministic L1 rule labels.',
            'Then call label_segment or keep_segment for each unresolved id.',
            'Call read_segment only when WINDOW_CARDS are not enough; results are masked.',
            'Call check_continuity only for adjacent keep-path questions.',
            TRACE_DATA_NOTICE,
          ].join(' '),
          skill_text,
          skeleton_text: JSON.stringify(input.skeleton),
          messages,
          text: composeCutBrainText({
            intent: input.intent,
            unresolved,
            windowIds,
            cards,
            rulesHintApplied,
            round,
          }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`cut_brain_round_${String(round)}_failed:${message}`)
        break
      }

      usage = {
        role: session.role,
        input_tokens: usage.input_tokens + result.usage.input_tokens,
        output_tokens: usage.output_tokens + result.usage.output_tokens,
      }

      if (result.tool_calls.length === 0) {
        notes.push(`cut_brain_round_${String(round)}_no_tool_calls`)
        break
      }

      const maskedLines: string[] = []
      const readCtx: HoleReadContext = { cards, raw: input.raw }

      for (const call of result.tool_calls) {
        const handled = interpretToolCall(call, {
          openIds,
          readCtx,
          skill,
          view,
          raw: input.raw,
          rulesHintApplied,
          rulesCache,
        })
        if (handled.note !== undefined) notes.push(handled.note)
        if (handled.rules !== undefined) {
          rulesCache = handled.rules
          rulesHintApplied = true
          view = handled.rules.view
          for (const d of handled.rules.decisions) {
            if (!openIds.has(d.segment_id)) continue
            if (decisions.has(d.segment_id)) continue
            decisions.set(d.segment_id, d)
          }
        }
        for (const d of handled.decisions) {
          if (!decisions.has(d.segment_id)) decisions.set(d.segment_id, d)
        }
        maskedLines.push(
          formatMaskedForPrompt(maskToolResult(handled.maskPayload, { toolName: call.name })),
        )
      }

      messages.push({
        role: 'assistant',
        content: `tool_calls: ${result.tool_calls.map((c) => c.name).join(', ')}`,
      })
      messages.push({
        role: 'user',
        content: [
          'MASKED_TOOL_RESULTS (ADR-0010; full payloads not re-injected):',
          ...maskedLines,
          rulesHintApplied ? 'RULES_HINT_APPLIED=true' : 'RULES_HINT_APPLIED=false',
          `still_unresolved: ${JSON.stringify(input.segment_ids.filter((id) => !decisions.has(id)))}`,
        ].join('\n'),
      })
    }
  } finally {
    session.dispose()
  }

  const still_unresolved = input.segment_ids.filter((id) => !decisions.has(id))
  const output: CutBrainOutput = {
    decisions: [...decisions.values()],
    still_unresolved,
    view,
    usage,
    rules_hint_applied: rulesHintApplied,
  }
  if (notes.length > 0) output.notes = notes
  return output
}

function composeCutBrainText(input: {
  intent: IntentHypothesis
  unresolved: readonly string[]
  windowIds: readonly string[]
  cards: readonly SegmentCard[]
  rulesHintApplied: boolean
  round: number
}): string {
  const lines = [
    `intent: ${input.intent.text}`,
    `round: ${String(input.round)}`,
    `RULES_HINT_APPLIED=${String(input.rulesHintApplied)}`,
    `unresolved_ids: ${JSON.stringify(input.unresolved)}`,
    `window_segment_ids: ${JSON.stringify(input.windowIds)}`,
    `WINDOW_CARDS:\n${cardIndexPayload(input.cards.filter((c) => input.unresolved.includes(c.id) || input.windowIds.includes(c.id)))}`,
  ]
  if (!input.rulesHintApplied) {
    lines.push(
      'First you may call apply_rules_hint() to endorse L1 rules (masked summary + unresolved).',
    )
  }
  lines.push(
    'For each unresolved id in window_segment_ids, call label_segment({segment_id,label,confidence}) or keep_segment({segment_id}).',
    'Do not invent ids. Unresolved stay unresolved until you label or keep.',
  )
  return lines.join('\n\n')
}

function interpretToolCall(
  call: SessionToolCall,
  ctx: {
    openIds: ReadonlySet<string>
    readCtx: HoleReadContext
    skill: string
    view: AgentView
    raw: RawTrace
    rulesHintApplied: boolean
    rulesCache: RulesOutput | undefined
  },
): {
  decisions: LabelDecision[]
  rules?: RulesOutput
  maskPayload: unknown
  note?: string
} {
  if (call.name === 'apply_rules_hint') {
    const accepted = handleApplyRulesHint(call.arguments)
    if (!accepted.ok) {
      return {
        decisions: [],
        maskPayload: { kind: 'apply_rules_hint', error: accepted.error },
        note: `apply_rules_hint_rejected:${accepted.error}`,
      }
    }
    if (ctx.rulesHintApplied && ctx.rulesCache !== undefined) {
      const unresolved = ctx.rulesCache.unresolved_ids
      return {
        decisions: [],
        maskPayload: {
          kind: 'apply_rules_hint',
          applied: true,
          resolved_count: ctx.rulesCache.decisions.length,
          unresolved_ids: unresolved,
          summary: 'rules already applied this session',
        },
      }
    }
    const rules = applyRules({ view: ctx.view, raw: ctx.raw })
    return {
      decisions: [],
      rules,
      maskPayload: {
        kind: 'apply_rules_hint',
        applied: true,
        resolved_count: rules.decisions.length,
        unresolved_ids: rules.unresolved_ids,
        summary: `rules resolved ${String(rules.decisions.length)}; unresolved ${String(rules.unresolved_ids.length)}`,
      },
    }
  }

  if (call.name === 'label_segment') {
    const accepted = handleLabelSegment(call.arguments, ctx.openIds)
    if (!accepted.ok) {
      return {
        decisions: [],
        maskPayload: { segment_id: null, label: null, confidence: null, error: accepted.error },
        note: `label_segment_rejected:${accepted.error}`,
      }
    }
    return {
      decisions: [
        {
          segment_id: accepted.segment_id,
          label: accepted.label,
          source: { kind: 'llm', name: ctx.skill },
          confidence: accepted.confidence,
        },
      ],
      maskPayload: {
        segment_id: accepted.segment_id,
        label: accepted.label,
        confidence: accepted.confidence,
      },
    }
  }

  if (call.name === 'keep_segment') {
    const accepted = handleKeepSegment(call.arguments, ctx.openIds)
    if (!accepted.ok) {
      return {
        decisions: [],
        maskPayload: { kind: 'keep_segment', error: accepted.error },
        note: `keep_segment_rejected:${accepted.error}`,
      }
    }
    // Explicit keep → key_decision so writeWarrant / profile maps to keep.
    return {
      decisions: [
        {
          segment_id: accepted.segment_id,
          label: 'key_decision',
          source: { kind: 'llm', name: 'keep_segment' },
          confidence: accepted.confidence,
        },
      ],
      maskPayload: {
        kind: 'keep_segment',
        segment_id: accepted.segment_id,
        confidence: accepted.confidence,
      },
    }
  }

  if (call.name === 'read_segment') {
    const accepted = handleReadSegment(ctx.readCtx, call.arguments)
    if (!accepted.ok) {
      return {
        decisions: [],
        maskPayload: { segment_id: null, focus: 'full', text: '', error: accepted.error },
        note: `read_segment_rejected:${accepted.error}`,
      }
    }
    return {
      decisions: [],
      maskPayload: {
        segment_id: accepted.segment_id,
        focus: accepted.focus,
        text: accepted.text,
      },
    }
  }

  if (call.name === 'check_continuity') {
    // Continuity scores are observational for cut-brain v0; mask ack only.
    return {
      decisions: [],
      maskPayload: call.arguments,
    }
  }

  return {
    decisions: [],
    maskPayload: { ignored: call.name },
    note: `cut_brain_ignored_tool:${call.name}`,
  }
}

function loadSkillText(input: CutBrainInput): string {
  if (input.skill_text !== undefined && input.skill_text.length > 0) return input.skill_text
  const base = input.skill_path.split(/[\\/]/).pop() ?? input.skill_path
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    input.skill_path,
    join(process.cwd(), input.skill_path),
    join(process.cwd(), 'src', input.skill_path),
    join(here, '..', 'skills', base),
  ]
  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8').trim()
      if (text.length > 0) return text
    } catch {
      continue
    }
  }
  throw new Error(`cutBrain: cannot load skill text from ${input.skill_path}`)
}

function skillSourceName(skill_path: string): string {
  const base = skill_path.split(/[\\/]/).pop() ?? skill_path
  return base.replace(/\.md$/i, '')
}

/** Test helper: expose prompt shape without running a session. */
export function previewCutBrainPromptText(
  input: Parameters<typeof composeCutBrainText>[0],
): string {
  return composeCutBrainText(input)
}

export type { SessionPromptResult }
