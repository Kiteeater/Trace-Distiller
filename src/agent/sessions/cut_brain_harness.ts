/**
 * ADR-0012 cut-brain harness: S0–S3, single-slot focus, S2 evidence cards, keep bits.
 * Pure functions — no pi, no IO. The loop lives in cut_brain.ts.
 */
import {
  CARD_INDEX_HEAD_MAX_CHARS,
  CUT_BRAIN_FOCUS_SLOT,
  CUT_BRAIN_LOW_CONFIDENCE,
  CUT_BRAIN_MAX_ROUNDS,
  CUT_BRAIN_PER_SEGMENT_DISCLOSE_CAP,
  CUT_BRAIN_ROUNDS_PER_UNRESOLVED,
  CUT_BRAIN_SCHEMA_RETRIES,
  EVIDENCE_CARD_KINDS,
  KEEP_EVIDENCE_BITS,
  S2_EVIDENCE_CARD_TOKEN_CAP,
  WRITE_OUTLIER_TOKEN_FLOOR,
  WRITE_OUTLIER_TOKEN_MULTIPLIER,
  type EvidenceCardKind,
  type KeepEvidenceBit,
} from '../../constant/window.ts'
import {
  COLLAPSE_UNCERTAIN_RULE,
  DROP_BY_POLICY_RULE,
  SKELETON_PROTECT_RULE,
} from '../../domain/cut_decision.ts'
import type { LabelDecision } from '../../domain/label_decision.ts'
import { LABELS, type Label } from '../../enums/label.ts'
import type { Scenario } from '../../enums/scenario.ts'
import type { IntentHypothesis, Skeleton } from '../../types/agent_view.ts'
import type { RawTrace } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'
import { estimateTokens } from '../../utils/tokens.ts'
import { parseEvidenceKind } from '../extension.ts'
import { cardIndexEntry } from './card_index.ts'

export const HOLE_B_JSON_KIND = 'hole_b_turn_v1' as const

/** Labels that map to keep under DEFAULT_CUT_PROFILE (keep proposals). */
export const KEEP_PROPOSAL_LABELS: readonly Label[] = ['key_decision', 'useful_exploration']

export interface EvidenceCard {
  card_id: string
  segment_id: string
  kind: EvidenceCardKind
  tokens: number
  fields: Record<string, unknown>
  truncated: boolean
}

export interface CutBrainMetrics {
  rounds: number
  focus_slot: typeof CUT_BRAIN_FOCUS_SLOT
  single_slot_violations: number
  evidence_card_violations: number
  illegal_keep_overrides: number
  over_threshold_count: number
  over_threshold_keep_count: number
}

export interface HoleBRawTurn {
  json: unknown | null
  tool_calls: ReadonlyArray<{ name: string; arguments: unknown }>
}

export type ParsedHoleBTurn =
  | { ok: true; action: 'apply_rules_hint' }
  | {
      ok: true
      action: 'evidence_request'
      segment_id: string
      evidence_kind: EvidenceCardKind
      confidence: number
    }
  | {
      ok: true
      action: 'decision'
      segment_id: string
      label: Label
      confidence: number
      keep_bits: KeepEvidenceBit[]
      from_keep_segment: boolean
    }
  | {
      ok: false
      error: string
      single_slot_violation: boolean
      evidence_card_violation: boolean
    }

export interface FocusPick {
  card: SegmentCard
  outlier: boolean
  in_skeleton: boolean
}

export function roundBudget(unresolvedCount: number, maxRoundsCap?: number): number {
  const operational = Math.max(1, unresolvedCount) * CUT_BRAIN_ROUNDS_PER_UNRESOLVED
  const abs = maxRoundsCap ?? CUT_BRAIN_MAX_ROUNDS
  return Math.min(operational, abs, CUT_BRAIN_MAX_ROUNDS)
}

export function isLowConfidence(confidence: number): boolean {
  return confidence < CUT_BRAIN_LOW_CONFIDENCE
}

export function isKeepProposalLabel(label: Label): boolean {
  return (KEEP_PROPOSAL_LABELS as readonly string[]).includes(label)
}

export function skeletonSegmentIds(skeleton: Skeleton): Set<string> {
  const ids = new Set<string>()
  for (const node of skeleton.nodes) {
    for (const id of node.segment_ids) ids.add(id)
  }
  return ids
}

export function tokenMedian(cards: readonly SegmentCard[]): number {
  const xs = cards.map((c) => c.tokens).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (xs.length === 0) return 0
  const mid = Math.floor(xs.length / 2)
  const even = xs.length % 2 === 0
  if (even) {
    const a = xs[mid - 1] ?? 0
    const b = xs[mid] ?? 0
    return (a + b) / 2
  }
  return xs[mid] ?? 0
}

export function isWriteSegment(card: SegmentCard): boolean {
  if (card.writes.length > 0) return true
  return /^(write|edit)$/i.test(card.tool.trim())
}

export function isWriteOutlier(card: SegmentCard, median: number): boolean {
  if (!isWriteSegment(card)) return false
  const floor = Math.max(median * WRITE_OUTLIER_TOKEN_MULTIPLIER, WRITE_OUTLIER_TOKEN_FLOOR)
  return card.tokens >= floor
}

/**
 * Focus priority: skeleton write-outlier > write-outlier > skeleton error > error > skeleton normal > normal.
 * Among write-outliers of the same rank, the largest token count wins; otherwise unresolved order.
 */
export function pickFocus(
  unresolved: readonly string[],
  cards: readonly SegmentCard[],
  skeletonIds: ReadonlySet<string>,
): FocusPick | undefined {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const unresolvedCards: SegmentCard[] = []
  for (const id of unresolved) {
    const card = byId.get(id)
    if (card !== undefined) unresolvedCards.push(card)
  }
  if (unresolvedCards.length === 0) return undefined
  const median = tokenMedian(cards)
  const outlierOf = (card: SegmentCard): boolean => isWriteOutlier(card, median)
  const rankOf = (card: SegmentCard): number => {
    const sk = skeletonIds.has(card.id)
    if (outlierOf(card)) return sk ? 0 : 1
    if (card.outcome === 'error') return sk ? 2 : 3
    return sk ? 4 : 5
  }
  let chosen = unresolvedCards[0]!
  let best = rankOf(chosen)
  for (let i = 1; i < unresolvedCards.length; i += 1) {
    const card = unresolvedCards[i]!
    const rank = rankOf(card)
    if (rank < best) {
      chosen = card
      best = rank
      continue
    }
    if (rank === best && outlierOf(card) && outlierOf(chosen) && card.tokens > chosen.tokens) {
      chosen = card
    }
  }
  return {
    card: chosen,
    outlier: outlierOf(chosen),
    in_skeleton: skeletonIds.has(chosen.id),
  }
}

export function focusCardPayload(
  card: SegmentCard,
  opts: { in_skeleton: boolean; outlier: boolean },
): Record<string, unknown> {
  const entry = cardIndexEntry(card)
  return {
    ...entry,
    tokens: card.tokens,
    reads_n: card.reads.length,
    writes_n: card.writes.length,
    in_skeleton: opts.in_skeleton,
    outlier: opts.outlier,
    error: card.outcome === 'error',
    focus_slot: CUT_BRAIN_FOCUS_SLOT,
  }
}

export function s0Pointers(input: {
  intent: IntentHypothesis
  skeleton: Skeleton
  decided_n: number
  unresolved_n: number
  defer_n: number
}): Record<string, unknown> {
  const scenario: Scenario | undefined = input.intent.scenario
  return {
    intent: input.intent.text,
    ...(scenario !== undefined ? { scenario } : {}),
    skeleton_nodes: input.skeleton.nodes.length,
    skeleton_segments: skeletonSegmentIds(input.skeleton).size,
    decided_n: input.decided_n,
    unresolved_n: input.unresolved_n,
    defer_n: input.defer_n,
  }
}

export function s3Payload(skill_id: string): Record<string, unknown> {
  return {
    skill_id,
    criteria: [...KEEP_EVIDENCE_BITS],
  }
}

export function emptyMetrics(): CutBrainMetrics {
  return {
    rounds: 0,
    focus_slot: CUT_BRAIN_FOCUS_SLOT,
    single_slot_violations: 0,
    evidence_card_violations: 0,
    illegal_keep_overrides: 0,
    over_threshold_count: 0,
    over_threshold_keep_count: 0,
  }
}

export function overThresholdKeepRate(metrics: CutBrainMetrics): number {
  if (metrics.over_threshold_count <= 0) return 0
  return metrics.over_threshold_keep_count / metrics.over_threshold_count
}

export function illegalKeepOverrideRatio(metrics: CutBrainMetrics): number {
  if (metrics.rounds <= 0) return 0
  return metrics.illegal_keep_overrides / metrics.rounds
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function requiredId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseKeepBitsValue(value: unknown): { ok: true; bits: KeepEvidenceBit[] } | { ok: false } {
  if (value === undefined) return { ok: true, bits: [] }
  if (!Array.isArray(value)) return { ok: false }
  const bits: KeepEvidenceBit[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(KEEP_EVIDENCE_BITS as readonly string[]).includes(item)) {
      return { ok: false }
    }
    if (!bits.includes(item as KeepEvidenceBit)) bits.push(item as KeepEvidenceBit)
  }
  return { ok: true, bits }
}

function parseConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
  return value
}

function parseLabel(value: unknown): Label | undefined {
  if (typeof value !== 'string') return undefined
  if (!(LABELS as readonly string[]).includes(value)) return undefined
  return value as Label
}

function toolArgRecord(call: { arguments: unknown }): Record<string, unknown> {
  return asRecord(call.arguments) ?? {}
}

/**
 * Parse one B turn. v1: only the current focus_id is legal.
 * Same-turn evidence_request wins over decision (disclose next turn).
 */
export function parseHoleBTurn(result: HoleBRawTurn, focusId: string): ParsedHoleBTurn {
  const json = asRecord(result.json)
  if (json !== undefined) {
    const focus = json.focus
    if (typeof focus === 'number' && focus !== CUT_BRAIN_FOCUS_SLOT) {
      return {
        ok: false,
        error: 'focus must be 1',
        single_slot_violation: true,
        evidence_card_violation: false,
      }
    }
  }

  const calls = result.tool_calls
  const hintOnly = calls.length > 0 && calls.every((c) => c.name === 'apply_rules_hint')
  if (hintOnly) return { ok: true, action: 'apply_rules_hint' }
  if (calls.length === 1 && calls[0]?.name === 'apply_rules_hint') {
    return { ok: true, action: 'apply_rules_hint' }
  }

  const judgment = calls.filter((c) => c.name !== 'apply_rules_hint')
  const labeledIds: string[] = []
  const readCalls = judgment.filter((c) => c.name === 'read_segment')
  const labelCalls = judgment.filter((c) => c.name === 'label_segment' || c.name === 'keep_segment')

  for (const call of [...readCalls, ...labelCalls]) {
    const id = requiredId(toolArgRecord(call).segment_id)
    if (id !== undefined) labeledIds.push(id)
  }

  let jsonId = json !== undefined ? requiredId(json.segment_id) : undefined
  const addressed = new Set(labeledIds)
  if (jsonId !== undefined) addressed.add(jsonId)

  let single_slot_violation = false
  if (addressed.size > 1) single_slot_violation = true
  for (const id of addressed) {
    if (id !== focusId) single_slot_violation = true
  }

  if (readCalls.length > 1) {
    return {
      ok: false,
      error: 'same-turn multiple evidence cards',
      single_slot_violation,
      evidence_card_violation: true,
    }
  }

  const jsonEvidence = json !== undefined ? json.evidence_request : undefined
  const wantsEvidenceFromJson =
    jsonEvidence !== undefined && jsonEvidence !== null && jsonEvidence !== ''
  const readCall = readCalls[0]

  if (wantsEvidenceFromJson || readCall !== undefined) {
    const kindRaw =
      readCall !== undefined
        ? (toolArgRecord(readCall).kind ?? jsonEvidence ?? 'structure')
        : jsonEvidence
    const kind = parseEvidenceKind(kindRaw) ?? (kindRaw === 'structure' || kindRaw === 'headtail' || kindRaw === 'error'
      ? (kindRaw as EvidenceCardKind)
      : undefined)
    if (kind === undefined || !(EVIDENCE_CARD_KINDS as readonly string[]).includes(String(kindRaw))) {
      return {
        ok: false,
        error: 'evidence_request must be structure|headtail|error',
        single_slot_violation,
        evidence_card_violation: true,
      }
    }
    const sid =
      (readCall !== undefined ? requiredId(toolArgRecord(readCall).segment_id) : undefined) ??
      jsonId ??
      focusId
    if (sid !== focusId) {
      return {
        ok: false,
        error: 'evidence_request segment_id is not the focus',
        single_slot_violation: true,
        evidence_card_violation: false,
      }
    }
    const confidence =
      parseConfidence(json?.confidence) ??
      parseConfidence(readCall !== undefined ? toolArgRecord(readCall).confidence : undefined) ??
      0
    return {
      ok: true,
      action: 'evidence_request',
      segment_id: sid,
      evidence_kind: kind,
      confidence,
    }
  }

  const labelCall = labelCalls[0]
  let label: Label | undefined
  let confidence: number | undefined
  let keep_bits: KeepEvidenceBit[] = []
  let from_keep_segment = false
  let segment_id = focusId

  if (labelCall !== undefined) {
    const rec = toolArgRecord(labelCall)
    const sid = requiredId(rec.segment_id)
    if (sid === undefined) {
      return {
        ok: false,
        error: 'decision missing segment_id',
        single_slot_violation,
        evidence_card_violation: false,
      }
    }
    segment_id = sid
    if (labelCall.name === 'keep_segment') {
      from_keep_segment = true
      label = 'key_decision'
      confidence = parseConfidence(rec.confidence) ?? 1
    } else {
      label = parseLabel(rec.label)
      confidence = parseConfidence(rec.confidence)
    }
    const bits = parseKeepBitsValue(rec.keep_bits)
    if (!bits.ok) {
      return {
        ok: false,
        error: 'keep_bits must be skeleton_hit|key_decision_flag',
        single_slot_violation,
        evidence_card_violation: false,
      }
    }
    keep_bits = bits.bits
  } else if (json !== undefined) {
    const decision = json.decision
    if (decision === null || decision === undefined) {
      return {
        ok: false,
        error: 'no decision and no evidence_request',
        single_slot_violation,
        evidence_card_violation: false,
      }
    }
    label = parseLabel(decision)
    confidence = parseConfidence(json.confidence)
    const bits = parseKeepBitsValue(json.keep_bits)
    if (!bits.ok) {
      return {
        ok: false,
        error: 'keep_bits must be skeleton_hit|key_decision_flag',
        single_slot_violation,
        evidence_card_violation: false,
      }
    }
    keep_bits = bits.bits
    segment_id = jsonId ?? focusId
    from_keep_segment = json.from_keep_segment === true
  } else {
    return {
      ok: false,
      error: 'empty turn: no tool_calls and no json',
      single_slot_violation,
      evidence_card_violation: false,
    }
  }

  if (label === undefined) {
    return {
      ok: false,
      error: 'decision label is not in LABELS',
      single_slot_violation,
      evidence_card_violation: false,
    }
  }
  if (confidence === undefined) {
    return {
      ok: false,
      error: 'confidence must be a finite number in [0, 1]',
      single_slot_violation,
      evidence_card_violation: false,
    }
  }
  if (segment_id !== focusId || single_slot_violation) {
    return {
      ok: false,
      error: 'decision segment_id is not the single focus',
      single_slot_violation: true,
      evidence_card_violation: false,
    }
  }
  if (labelCalls.length > 1) {
    return {
      ok: false,
      error: 'same-turn multiple decisions',
      single_slot_violation: true,
      evidence_card_violation: false,
    }
  }

  return {
    ok: true,
    action: 'decision',
    segment_id,
    label,
    confidence,
    keep_bits,
    from_keep_segment,
  }
}

export function validatedKeepBits(input: {
  keep_bits: readonly KeepEvidenceBit[]
  segment_id: string
  skeletonIds: ReadonlySet<string>
  label: Label
  from_keep_segment: boolean
}): KeepEvidenceBit[] {
  const out: KeepEvidenceBit[] = []
  for (const bit of input.keep_bits) {
    if (bit === 'skeleton_hit') {
      if (input.skeletonIds.has(input.segment_id)) out.push(bit)
      continue
    }
    if (bit === 'key_decision_flag') {
      if (input.label === 'key_decision' || input.from_keep_segment) out.push(bit)
    }
  }
  return out
}

export function keepIsLegal(input: {
  label: Label
  confidence: number
  keep_bits: readonly KeepEvidenceBit[]
  segment_id: string
  skeletonIds: ReadonlySet<string>
  from_keep_segment: boolean
  /** Write-outlier focus. Non-skeleton outlier keep is rejected even with legal bits. */
  outlier?: boolean
}): { legal: true; bits: KeepEvidenceBit[] } | { legal: false; reason: string } {
  if (!isKeepProposalLabel(input.label) && !input.from_keep_segment) {
    return { legal: true, bits: [] }
  }
  if (isLowConfidence(input.confidence)) {
    return { legal: false, reason: 'low_confidence_keep' }
  }
  const bits = validatedKeepBits(input)
  if (bits.length === 0) {
    return { legal: false, reason: 'missing_keep_bits' }
  }
  // ADR-0012: over-threshold Write must not default keep. Skeleton protect (#53) wins:
  // do not demote skeleton outliers here (illegal-keep / exhaust still force-keep).
  if (input.outlier === true && !input.skeletonIds.has(input.segment_id)) {
    return { legal: false, reason: 'non_skeleton_outlier_keep' }
  }
  return { legal: true, bits }
}

export function collapseUncertainDecision(
  segment_id: string,
  confidence: number,
  sourceName: string = COLLAPSE_UNCERTAIN_RULE,
): LabelDecision {
  return {
    segment_id,
    label: 'collapse_uncertain',
    source: { kind: 'rule', name: sourceName },
    confidence,
  }
}

/** Legal keep for a Hole A skeleton segment (skeleton_hit conceptually; never collapse_uncertain). */
export function forceSkeletonKeep(segment_id: string): LabelDecision {
  return {
    segment_id,
    label: 'key_decision',
    source: { kind: 'rule', name: SKELETON_PROTECT_RULE },
    confidence: 1,
    rule_name: SKELETON_PROTECT_RULE,
  }
}

/** ADR-0012 collapse_uncertain, unless the id is Hole A skeleton — then force keep. */
export function resolveUncertainOrProtect(
  segment_id: string,
  confidence: number,
  skeletonIds: ReadonlySet<string>,
): LabelDecision {
  if (skeletonIds.has(segment_id)) return forceSkeletonKeep(segment_id)
  return collapseUncertainDecision(segment_id, confidence)
}

export function dropByPolicyDecision(segment_id: string, rule_name: string): LabelDecision {
  return {
    segment_id,
    label: 'routine',
    source: { kind: 'rule', name: DROP_BY_POLICY_RULE },
    confidence: 1,
    rule_name,
  }
}

function segmentRawText(card: SegmentCard, raw: RawTrace): string {
  const turnById = new Map(raw.turns.map((t) => [t.id, t]))
  const parts: string[] = []
  for (const ref of card.raw_refs) {
    const turn = turnById.get(ref)
    if (turn !== undefined) parts.push(turn.content)
  }
  return parts.join('\n')
}

function capString(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, Math.max(0, maxChars)), truncated: true }
}

function shrinkToTokenCap(
  fields: Record<string, unknown>,
  cap: number,
): { fields: Record<string, unknown>; tokens: number; truncated: boolean } {
  let current = { ...fields }
  let tokens = estimateTokens(JSON.stringify(current))
  if (tokens <= cap) return { fields: current, tokens, truncated: false }
  let truncated = false
  const keys = Object.keys(current).filter((k) => typeof current[k] === 'string')
  for (let step = 0; step < 12 && tokens > cap; step += 1) {
    truncated = true
    for (const key of keys) {
      const val = current[key]
      if (typeof val !== 'string' || val.length === 0) continue
      current = { ...current, [key]: val.slice(0, Math.max(8, Math.floor(val.length / 2))) }
    }
    tokens = estimateTokens(JSON.stringify(current))
  }
  if (tokens > cap) {
    truncated = true
    const slim: Record<string, unknown> = {
      id: current.id,
      kind: current.kind,
      truncated: true,
    }
    current = slim
    tokens = estimateTokens(JSON.stringify(current))
  }
  return { fields: current, tokens, truncated }
}

export function materializeEvidenceCard(input: {
  card: SegmentCard
  raw: RawTrace
  kind: EvidenceCardKind
  disclose_index: number
  cap?: number
}): EvidenceCard {
  const cap = input.cap ?? S2_EVIDENCE_CARD_TOKEN_CAP
  const card_id = `s2:${input.card.id}:${input.kind}:${String(input.disclose_index)}`
  const rawText = segmentRawText(input.card, input.raw)
  const charBudget = Math.max(32, cap * 4)

  let fields: Record<string, unknown>
  if (input.kind === 'structure') {
    const head =
      input.card.head.length <= CARD_INDEX_HEAD_MAX_CHARS
        ? input.card.head
        : input.card.head.slice(0, CARD_INDEX_HEAD_MAX_CHARS)
    fields = {
      id: input.card.id,
      kind: 'structure',
      tool: input.card.tool,
      sig: input.card.sig,
      outcome: input.card.outcome,
      tokens: input.card.tokens,
      reads_n: input.card.reads.length,
      writes_n: input.card.writes.length,
      reads: input.card.reads.slice(0, 8),
      writes: input.card.writes.slice(0, 8),
      head,
    }
    if (input.card.rep_of !== null) fields.rep_of = input.card.rep_of
  } else if (input.kind === 'headtail') {
    const half = Math.max(16, Math.floor(charBudget / 2))
    const head = capString(rawText, half)
    const tailSource = rawText.length > half ? rawText.slice(-half) : ''
    const tail = capString(tailSource, half)
    fields = {
      id: input.card.id,
      kind: 'headtail',
      total_chars: rawText.length,
      head: head.text,
      tail: tail.text,
      truncated: head.truncated || tail.truncated || rawText.length > charBudget,
    }
  } else {
    const excerpt = capString(rawText, Math.min(charBudget, 480))
    fields = {
      id: input.card.id,
      kind: 'error',
      tool: input.card.tool,
      sig: input.card.sig,
      outcome: input.card.outcome,
      error_excerpt: input.card.outcome === 'error' ? excerpt.text : excerpt.text.slice(0, 120),
      truncated: excerpt.truncated,
    }
  }

  const capped = shrinkToTokenCap(fields, cap)
  return {
    card_id,
    segment_id: input.card.id,
    kind: input.kind,
    tokens: capped.tokens,
    fields: capped.fields,
    truncated: capped.truncated,
  }
}

export function evidenceCardWithinCap(card: EvidenceCard, cap: number = S2_EVIDENCE_CARD_TOKEN_CAP): boolean {
  return card.tokens <= cap
}

export function formatMarked(name: string, value: unknown): string {
  return `---${name}---\n${JSON.stringify(value)}\n---END_${name}---`
}

export function composeSingleSlotText(input: {
  intent: IntentHypothesis
  skeleton: Skeleton
  skill_id: string
  focus: FocusPick
  decided_n: number
  unresolved_n: number
  defer_n: number
  rounds_left: number
  disclose_left: number
  evidence?: EvidenceCard
  rulesHintApplied: boolean
}): string {
  const lines = [
    `focus_slot: ${String(CUT_BRAIN_FOCUS_SLOT)}`,
    `focus_id: ${input.focus.card.id}`,
    `disclose_left: ${String(input.disclose_left)}`,
    `rounds_left: ${String(input.rounds_left)}`,
    `RULES_HINT_APPLIED=${String(input.rulesHintApplied)}`,
    formatMarked(
      'S0_POINTERS',
      s0Pointers({
        intent: input.intent,
        skeleton: input.skeleton,
        decided_n: input.decided_n,
        unresolved_n: input.unresolved_n,
        defer_n: input.defer_n,
      }),
    ),
    formatMarked(
      'FOCUS_CARD',
      focusCardPayload(input.focus.card, {
        in_skeleton: input.focus.in_skeleton,
        outlier: input.focus.outlier,
      }),
    ),
    formatMarked('S3', s3Payload(input.skill_id)),
  ]
  if (input.evidence !== undefined) {
    lines.push(
      formatMarked('EVIDENCE_CARD', {
        card_id: input.evidence.card_id,
        segment_id: input.evidence.segment_id,
        kind: input.evidence.kind,
        tokens: input.evidence.tokens,
        ...input.evidence.fields,
      }),
    )
  }
  if (!input.rulesHintApplied) {
    lines.push('Optional: call apply_rules_hint() once to endorse L1 rules (ACK only).')
  }
  lines.push(
    'Decide only focus_id. Reply with label_segment / keep_segment, or request one evidence card via read_segment({segment_id, kind: structure|headtail|error}).',
    'keep requires keep_bits skeleton_hit|key_decision_flag and confidence ≥ 0.5.',
    'If still unsure after disclose cap, label collapse_uncertain — never keep.',
  )
  return lines.join('\n\n')
}

export function discloseCap(): number {
  return CUT_BRAIN_PER_SEGMENT_DISCLOSE_CAP
}

export function schemaRetryCap(): number {
  return CUT_BRAIN_SCHEMA_RETRIES
}

export function s2TokenCap(): number {
  return S2_EVIDENCE_CARD_TOKEN_CAP
}
