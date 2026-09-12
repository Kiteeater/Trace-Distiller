import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CUT_BRAIN_TOOL_NAMES,
  handleApplyRulesHint,
} from '../extension.ts'
import {
  CUT_BRAIN_FOCUS_SLOT,
  CUT_BRAIN_ROUNDS_PER_UNRESOLVED,
  S2_EVIDENCE_CARD_TOKEN_CAP,
} from '../../constant/window.ts'
import { DROP_BY_POLICY_RULE } from '../../domain/cut_decision.ts'
import type { LabelDecision } from '../../domain/label_decision.ts'
import { applyRules, type RulesOutput } from '../../pipeline/rules.ts'
import type { AgentView, IntentHypothesis, Skeleton } from '../../types/agent_view.ts'
import type { RawTrace } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'
import {
  TRACE_DATA_NOTICE,
  type TokenUsage,
} from './skeleton_pass.ts'
import {
  composeSingleSlotText,
  discloseCap,
  dropByPolicyDecision,
  emptyMetrics,
  evidenceCardWithinCap,
  isKeepProposalLabel,
  keepIsLegal,
  materializeEvidenceCard,
  parseHoleBTurn,
  pickFocus,
  resolveUncertainOrProtect,
  roundBudget,
  schemaRetryCap,
  skeletonSegmentIds,
  type CutBrainMetrics,
  type EvidenceCard,
  type FocusPick,
} from './cut_brain_harness.ts'
import {
  openSession,
  type SessionBackend,
  type SessionMessage,
  type SessionPromptResult,
  type SessionToolCall,
} from './open_session.ts'

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
  metrics: CutBrainMetrics
}

/**
 * ADR-0012 cut-brain：单槽 focus=1 + 渐进披露 + collapse_uncertain。
 * S0 永不整包进 prompt；工具 execute = ACK + card_id。
 * 规则仅当 agent 调用 apply_rules_hint 时采纳（预算耗尽 drop_by_policy 除外）。
 */
export async function cutBrain(input: CutBrainInput): Promise<CutBrainOutput> {
  if (input.segment_ids.length === 0) {
    throw new Error('cutBrain: segment_ids is empty')
  }

  loadSkillText(input)
  const skill = skillSourceName(input.skill_path)
  const unresolved0 = input.segment_ids.length
  const budget = roundBudget(unresolved0, input.max_rounds)
  const openIds = new Set(input.segment_ids)
  const skeletonIds = skeletonSegmentIds(input.skeleton)
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
  const metrics = emptyMetrics()
  const discloseCount = new Map<string, number>()
  const schemaRetries = new Map<string, number>()
  const countedOutliers = new Set<string>()
  let pendingEvidence: EvidenceCard | undefined
  let hardFailed = false
  let usage: TokenUsage = {
    role: session.role,
    input_tokens: 0,
    output_tokens: 0,
  }
  let lastAck: string | undefined

  const cardsFor = (): SegmentCard[] => view.segments.filter((c) => openIds.has(c.id))

  try {
    for (let round = 0; round < budget; round += 1) {
      const unresolved = input.segment_ids.filter((id) => !decisions.has(id))
      if (unresolved.length === 0) break

      const focus = pickFocus(unresolved, cardsFor(), skeletonIds)
      if (focus === undefined) break
      metrics.rounds += 1
      if (focus.outlier && !countedOutliers.has(focus.card.id)) {
        countedOutliers.add(focus.card.id)
        metrics.over_threshold_count += 1
      }

      let visibleS2: EvidenceCard | undefined
      if (pendingEvidence !== undefined && pendingEvidence.segment_id === focus.card.id) {
        visibleS2 = pendingEvidence
      }
      pendingEvidence = undefined

      const discloseLeft = Math.max(0, discloseCap() - (discloseCount.get(focus.card.id) ?? 0))
      const messages: SessionMessage[] =
        lastAck !== undefined ? [{ role: 'user', content: lastAck }] : []

      let result: SessionPromptResult
      try {
        result = await session.prompt({
          system: [
            'You are the cut-brain editor-in-chief (ADR-0012).',
            `Single-slot: focus_slot is always ${String(CUT_BRAIN_FOCUS_SLOT)}; decide only focus_id.`,
            'Do not label multiple ids. Do not request full segment text.',
            'keep requires keep_bits skeleton_hit|key_decision_flag and confidence ≥ 0.5.',
            'If disclose cap is hit and you are still unsure, label collapse_uncertain (never keep).',
            'Optional: call apply_rules_hint once to endorse deterministic L1 rule labels.',
            TRACE_DATA_NOTICE,
          ].join(' '),
          messages,
          text: composeSingleSlotText({
            intent: input.intent,
            skeleton: input.skeleton,
            skill_id: skill,
            focus,
            decided_n: decisions.size,
            unresolved_n: unresolved.length,
            defer_n: 0,
            rounds_left: budget - round,
            disclose_left: discloseLeft,
            ...(visibleS2 !== undefined ? { evidence: visibleS2 } : {}),
            rulesHintApplied,
          }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notes.push(`cut_brain_round_${String(round)}_failed:${message}`)
        hardFailed = true
        break
      }

      usage = {
        role: session.role,
        input_tokens: usage.input_tokens + result.usage.input_tokens,
        output_tokens: usage.output_tokens + result.usage.output_tokens,
      }

      const hintCall = result.tool_calls.find((c) => c.name === 'apply_rules_hint')
      if (hintCall !== undefined && !rulesHintApplied) {
        const handled = applyRulesHintCall(hintCall, {
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
        lastAck = `ACK apply_rules_hint resolved=${String(handled.rules?.decisions.length ?? 0)} unresolved=${String(handled.rules?.unresolved_ids.length ?? 0)}`
        const onlyHint = result.tool_calls.every((c) => c.name === 'apply_rules_hint')
        if (onlyHint) continue
      }

      const restCalls = result.tool_calls.filter((c) => c.name !== 'apply_rules_hint')
      const parsed = parseHoleBTurn({ json: result.json, tool_calls: restCalls }, focus.card.id)

      if (parsed.ok === false) {
        if (parsed.single_slot_violation) metrics.single_slot_violations += 1
        if (parsed.evidence_card_violation) metrics.evidence_card_violations += 1
        notes.push(`cut_brain_round_${String(round)}_schema:${parsed.error}`)
        const used = (schemaRetries.get(focus.card.id) ?? 0) + 1
        schemaRetries.set(focus.card.id, used)
        if (used > schemaRetryCap()) {
          const decision = resolveUncertainOrProtect(focus.card.id, 0, skeletonIds)
          commit(decisions, decision, focus, metrics)
          lastAck = `ACK card_id=none segment_id=${focus.card.id} label=${decision.label}`
        } else if (visibleS2 !== undefined) {
          pendingEvidence = visibleS2
        }
        continue
      }

      if (parsed.action === 'apply_rules_hint') {
        lastAck = lastAck ?? 'ACK apply_rules_hint'
        continue
      }

      if (parsed.action === 'evidence_request') {
        const used = discloseCount.get(focus.card.id) ?? 0
        if (used >= discloseCap()) {
          const decision = resolveUncertainOrProtect(focus.card.id, parsed.confidence, skeletonIds)
          commit(decisions, decision, focus, metrics)
          lastAck = `ACK card_id=none segment_id=${focus.card.id} label=${decision.label}`
          continue
        }
        const card = materializeEvidenceCard({
          card: focus.card,
          raw: input.raw,
          kind: parsed.evidence_kind,
          disclose_index: used + 1,
          cap: S2_EVIDENCE_CARD_TOKEN_CAP,
        })
        if (!evidenceCardWithinCap(card)) metrics.evidence_card_violations += 1
        discloseCount.set(focus.card.id, used + 1)
        pendingEvidence = card
        lastAck = `ACK card_id=${card.card_id}`
        continue
      }

      const legal = keepIsLegal({
        label: parsed.label,
        confidence: parsed.confidence,
        keep_bits: parsed.keep_bits,
        segment_id: parsed.segment_id,
        skeletonIds,
        from_keep_segment: parsed.from_keep_segment,
        outlier: focus.outlier,
      })

      if (isKeepProposalLabel(parsed.label) || parsed.from_keep_segment) {
        if (!legal.legal) {
          metrics.illegal_keep_overrides += 1
          const decision = resolveUncertainOrProtect(focus.card.id, parsed.confidence, skeletonIds)
          commit(decisions, decision, focus, metrics)
          lastAck = `ACK card_id=none segment_id=${focus.card.id} label=${decision.label}`
          continue
        }
      }

      const sourceName = parsed.from_keep_segment ? 'keep_segment' : skill
      const decision: LabelDecision = {
        segment_id: parsed.segment_id,
        label: parsed.label,
        source: { kind: 'llm', name: sourceName },
        confidence: parsed.confidence,
      }
      commit(decisions, decision, focus, metrics)
      lastAck = `ACK card_id=none segment_id=${parsed.segment_id} label=${parsed.label}`
    }
  } finally {
    session.dispose()
  }

  const leftover = input.segment_ids.filter((id) => !decisions.has(id))
  if (leftover.length > 0 && !hardFailed) {
    const operational = unresolved0 * CUT_BRAIN_ROUNDS_PER_UNRESOLVED
    const testCapped = input.max_rounds !== undefined && input.max_rounds < operational
    if (!testCapped) {
      exhaustRemaining(leftover, {
        view,
        raw: input.raw,
        decisions,
        rulesCache,
        notes,
        skeletonIds,
      })
    }
  }

  const still_unresolved = input.segment_ids.filter((id) => !decisions.has(id))
  const output: CutBrainOutput = {
    decisions: [...decisions.values()],
    still_unresolved,
    view,
    usage,
    rules_hint_applied: rulesHintApplied,
    metrics,
  }
  if (notes.length > 0) output.notes = notes
  return output
}

function commit(
  decisions: Map<string, LabelDecision>,
  decision: LabelDecision,
  focus: FocusPick,
  metrics: CutBrainMetrics,
): void {
  if (decisions.has(decision.segment_id)) return
  decisions.set(decision.segment_id, decision)
  if (focus.outlier && isKeepProposalLabel(decision.label)) {
    metrics.over_threshold_keep_count += 1
  }
}

function exhaustRemaining(
  leftover: readonly string[],
  ctx: {
    view: AgentView
    raw: RawTrace
    decisions: Map<string, LabelDecision>
    rulesCache: RulesOutput | undefined
    notes: string[]
    skeletonIds: ReadonlySet<string>
  },
): void {
  const rules = ctx.rulesCache ?? applyRules({ view: ctx.view, raw: ctx.raw })
  const byId = new Map(rules.decisions.map((d) => [d.segment_id, d]))
  for (const id of leftover) {
    if (ctx.decisions.has(id)) continue
    const ruled = byId.get(id)
    if (ruled !== undefined && ruled.label === 'routine') {
      ctx.decisions.set(id, dropByPolicyDecision(id, ruled.rule_name ?? DROP_BY_POLICY_RULE))
      continue
    }
    ctx.decisions.set(id, resolveUncertainOrProtect(id, 0, ctx.skeletonIds))
  }
  ctx.notes.push(`cut_brain_budget_exhaust:${String(leftover.length)}`)
}

function applyRulesHintCall(
  call: SessionToolCall,
  ctx: {
    view: AgentView
    raw: RawTrace
    rulesHintApplied: boolean
    rulesCache: RulesOutput | undefined
  },
): {
  rules?: RulesOutput
  note?: string
} {
  const accepted = handleApplyRulesHint(call.arguments)
  if (!accepted.ok) {
    return { note: `apply_rules_hint_rejected:${accepted.error}` }
  }
  if (ctx.rulesHintApplied && ctx.rulesCache !== undefined) {
    return { rules: ctx.rulesCache }
  }
  return { rules: applyRules({ view: ctx.view, raw: ctx.raw }) }
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
  input: Parameters<typeof composeSingleSlotText>[0],
): string {
  return composeSingleSlotText(input)
}

export type { SessionPromptResult, CutBrainMetrics, EvidenceCard }
