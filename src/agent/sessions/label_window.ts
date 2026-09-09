import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOLE_TOOL_NAMES,
  handleCheckContinuity,
  handleLabelSegment,
  handleReadSegment,
  type HoleReadContext,
} from '../extension.ts'
import { LABEL_WINDOW_SIZE } from '../../constant/window.ts'
import type { LabelDecision } from '../../domain/label_decision.ts'
import type { AgentView, IntentHypothesis, Skeleton, SkeletonNode } from '../../types/agent_view.ts'
import type { RawTrace } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'
import {
  TRACE_DATA_NOTICE,
  cardIndexEntry,
  NotImplementedError,
  type TokenUsage,
} from './skeleton_pass.ts'
import {
  openSession,
  parseStructuredJson,
  type SessionBackend,
  type SessionPromptResult,
} from './open_session.ts'

export interface LabelWindowInput {
  segment_ids: string[]
  view: AgentView
  raw: RawTrace
  skeleton: Skeleton
  intent: IntentHypothesis
  /** orchestrator 查表后传入。source.name 取文件名。 */
  skill_path: string
  /** 已读的 skill Markdown；缺省则按 skill_path 读盘。禁止静默空 prompt。 */
  skill_text?: string
  /** 测试注入；生产省略。 */
  backend?: SessionBackend
}

export interface SkeletonPatch {
  upsert_nodes: SkeletonNode[]
  remove_node_ids: string[]
}

export interface LabelWindowOutput {
  decisions: LabelDecision[]
  still_unlabeled: string[]
  skeleton_patch?: SkeletonPatch
  usage: TokenUsage
}

export interface ContinuityPairResult {
  ok: boolean
  score: number
  reason: string
  usage: TokenUsage
}

/**
 * 洞 B 逐窗打标。一窗一会话。挂 extension 三工具。
 * 只收集 label_segment → LabelDecision；未调用的 id 不瞎标，返回 still_unlabeled。
 * 无任何 label_segment 调用则失败，交给编排器 Fail-Closed Keep。
 */
export async function labelWindow(input: LabelWindowInput): Promise<LabelWindowOutput> {
  if (input.segment_ids.length === 0) {
    throw new Error('labelWindow: window is empty')
  }
  if (input.segment_ids.length > LABEL_WINDOW_SIZE) {
    throw new Error(`labelWindow: window exceeds LABEL_WINDOW_SIZE=${String(LABEL_WINDOW_SIZE)}`)
  }

  const windowIds = new Set(input.segment_ids)
  const cards = input.view.segments.filter((c) => windowIds.has(c.id))
  const skill_text = loadSkillText(input)
  const skill = skillSourceName(input.skill_path)
  const session = openHoleB(input.backend)
  try {
    const result = await session.prompt({
      system: [
        'Label each unresolved segment by calling label_segment with a four-class Label.',
        'Call read_segment only when you need this segment\'s raw text; it returns that segment only.',
        'Call check_continuity only for adjacent keep-path questions.',
        TRACE_DATA_NOTICE,
      ].join(' '),
      skill_text,
      skeleton_text: JSON.stringify(input.skeleton),
      text: composeLabelWindowText(input, cards),
    })
    return interpretLabelWindowResult(result, {
      windowIds,
      orderedIds: input.segment_ids,
      skill,
      cards,
      raw: input.raw,
      role: session.role,
    })
  } finally {
    session.dispose()
  }
}

/**
 * 衔接检查复用洞 B 会话工具，不是新洞。
 */
export async function checkContinuityPair(
  left: SegmentCard,
  right: SegmentCard,
  skeleton: Skeleton,
  backend?: SessionBackend,
): Promise<ContinuityPairResult> {
  const session = openHoleB(backend)
  try {
    const result = await session.prompt({
      system: [
        'Call check_continuity once for the given adjacent pair.',
        'Score 1–5: can the later step be reached from the earlier one?',
        TRACE_DATA_NOTICE,
      ].join(' '),
      skeleton_text: JSON.stringify(skeleton),
      text: [
        `left: ${JSON.stringify(cardIndexEntry(left))}`,
        `right: ${JSON.stringify(cardIndexEntry(right))}`,
        'Call check_continuity with left_id, right_id, reachable, score (1-5), reason.',
      ].join('\n'),
    })
    return interpretContinuityResult(result, left.id, right.id, session.role)
  } finally {
    session.dispose()
  }
}

export { NotImplementedError }

function openHoleB(backend?: SessionBackend) {
  return openSession({
    role: 'hole_b_label',
    tools: HOLE_TOOL_NAMES,
    ...(backend !== undefined ? { backend } : {}),
  })
}

function composeLabelWindowText(input: LabelWindowInput, cards: SegmentCard[]): string {
  return [
    `intent: ${input.intent.text}`,
    `window_segment_ids: ${JSON.stringify(input.segment_ids)}`,
    `WINDOW_CARDS (not full; use read_segment to upgrade one id):\n${JSON.stringify(cards.map(cardIndexEntry))}`,
    'For each unresolved id, call label_segment({ segment_id, label, confidence }).',
    'Do not label ids you did not inspect. Do not invent labels.',
  ].join('\n\n')
}

function interpretLabelWindowResult(
  result: SessionPromptResult,
  ctx: {
    windowIds: ReadonlySet<string>
    orderedIds: readonly string[]
    skill: string
    cards: readonly SegmentCard[]
    raw: RawTrace
    role: TokenUsage['role']
  },
): LabelWindowOutput {
  const calls = result.tool_calls
  const readCtx: HoleReadContext = { cards: ctx.cards, raw: ctx.raw }
  for (const call of calls) {
    if (call.name === 'read_segment') {
      handleReadSegment(readCtx, call.arguments)
    }
  }

  const labelCalls = calls.filter((c) => c.name === 'label_segment')
  if (labelCalls.length === 0) {
    throw new Error('labelWindow: no label_segment tool calls; do not invent labels')
  }

  const decisions: LabelDecision[] = []
  const labeled = new Set<string>()
  for (const call of labelCalls) {
    const accepted = handleLabelSegment(call.arguments, ctx.windowIds)
    if (!accepted.ok) continue
    if (labeled.has(accepted.segment_id)) continue
    labeled.add(accepted.segment_id)
    decisions.push({
      segment_id: accepted.segment_id,
      label: accepted.label,
      source: { kind: 'llm', name: ctx.skill },
      confidence: accepted.confidence,
    })
  }

  const still_unlabeled = ctx.orderedIds.filter((id) => !labeled.has(id))
  const patch = parseSkeletonPatch(result.json ?? tryJson(result.text))
  const output: LabelWindowOutput = {
    decisions,
    still_unlabeled,
    usage: {
      role: ctx.role,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  }
  if (patch !== undefined) output.skeleton_patch = patch
  return output
}

function interpretContinuityResult(
  result: SessionPromptResult,
  leftId: string,
  rightId: string,
  role: TokenUsage['role'],
): ContinuityPairResult {
  const call = result.tool_calls.find((c) => c.name === 'check_continuity')
  if (call === undefined) {
    throw new Error('checkContinuityPair: no check_continuity tool call; do not invent scores')
  }
  const accepted = handleCheckContinuity(call.arguments)
  if (!accepted.ok) {
    throw new Error(`checkContinuityPair: ${accepted.error}`)
  }
  if (accepted.left_id !== leftId || accepted.right_id !== rightId) {
    throw new Error('checkContinuityPair: tool call ids do not match the pair')
  }
  return {
    ok: accepted.reachable,
    score: accepted.score,
    reason: accepted.reason,
    usage: {
      role,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  }
}

function parseSkeletonPatch(value: unknown): SkeletonPatch | undefined {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const patchRaw = rec.skeleton_patch ?? rec
  const patch = asRecord(patchRaw)
  if (patch === undefined) return undefined
  if (!Array.isArray(patch.upsert_nodes) && !Array.isArray(patch.remove_node_ids)) return undefined
  const upsert_nodes = Array.isArray(patch.upsert_nodes) ? (patch.upsert_nodes as SkeletonNode[]) : []
  const remove_node_ids = Array.isArray(patch.remove_node_ids)
    ? patch.remove_node_ids.filter((id): id is string => typeof id === 'string')
    : []
  return { upsert_nodes, remove_node_ids }
}

function loadSkillText(input: LabelWindowInput): string {
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
  throw new Error(`labelWindow: cannot load skill text from ${input.skill_path}`)
}

function skillSourceName(skill_path: string): string {
  const base = skill_path.split(/[\\/]/).pop() ?? skill_path
  return base.replace(/\.md$/i, '')
}

function tryJson(text: string): unknown {
  try {
    return parseStructuredJson(text)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
