import { SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD } from '../constant/window.ts'
import type { GraphHint, LabelDecision } from '../domain/label_decision.ts'
import type { Label } from '../enums/label.ts'
import type { AgentView } from '../types/agent_view.ts'
import type { RawTrace, RawTurn } from '../types/raw_trace.ts'
import type { SegmentCard } from '../types/segment.ts'

/** 稳定规则名：报告、凭证 source.name、SQLite 三处同一字符串。 */
export const RULE_FAILED_CALL_NO_FOLLOWUP = 'failed_call_no_followup'
export const RULE_REPEAT_READ = 'repeat_read'
export const RULE_SIMILAR_RETRY = 'similar_retry'
export const RULE_READ_THEN_LATER_WRITTEN = 'read_then_later_written'

const NON_ACTION_TOOLS = new Set(['thought', 'user', 'assistant', 'tool_result', ''])

export interface RulesInput {
  view: AgentView
  /** 仅当规则需要 outcome 原文；能只用卡片就只用卡片。 */
  raw: RawTrace
}

export interface FileDepGraph {
  nodes: string[]
  edges: Array<{ path: string; segment_id: string; op: 'read' | 'write' }>
}

export interface RulesOutput {
  view: AgentView
  decisions: LabelDecision[]
  unresolved_ids: string[]
  graph: FileDepGraph
}

/**
 * L1 规则层：能定的打标在进洞之前定完。不确定 → unresolved_ids。
 * 不调 LLM / pi / SQLite，不执行裁剪。
 */
export function applyRules(input: RulesInput): RulesOutput {
  const segments = input.view.segments.map(cloneCard)
  const graph = buildGraph(segments)
  const laterWritten = laterWrittenReads(segments)
  const rawById = indexTurns(input.raw.turns)
  const resolved = new Map<string, LabelDecision>()

  applySimilarRetry(segments, rawById, laterWritten, resolved)
  applyRepeatRead(segments, laterWritten, resolved)
  applyFailedCallNoFollowup(segments, laterWritten, resolved)

  for (const seg of segments) {
    if (resolved.has(seg.id)) {
      seg.focus = 'line'
    } else {
      seg.focus = 'card'
    }
  }

  const decisions = segments.flatMap((s) => {
    const d = resolved.get(s.id)
    return d === undefined ? [] : [d]
  })
  const unresolved_ids = segments.filter((s) => !resolved.has(s.id)).map((s) => s.id)

  return {
    view: { ...input.view, segments },
    decisions,
    unresolved_ids,
    graph,
  }
}

function cloneCard(seg: SegmentCard): SegmentCard {
  return { ...seg, reads: [...seg.reads], writes: [...seg.writes], raw_refs: [...seg.raw_refs] }
}

function indexTurns(turns: RawTurn[]): Map<string, RawTurn> {
  return new Map(turns.map((t) => [t.id, t]))
}

function buildGraph(segments: SegmentCard[]): FileDepGraph {
  const nodes: string[] = []
  const seen = new Set<string>()
  const edges: FileDepGraph['edges'] = []
  for (const seg of segments) {
    for (const path of seg.reads) {
      if (!seen.has(path)) {
        seen.add(path)
        nodes.push(path)
      }
      edges.push({ path, segment_id: seg.id, op: 'read' })
    }
    for (const path of seg.writes) {
      if (!seen.has(path)) {
        seen.add(path)
        nodes.push(path)
      }
      edges.push({ path, segment_id: seg.id, op: 'write' })
    }
  }
  return { nodes, edges }
}

/** 读过的路径被后续段 write → hint。同一段的读写不算「后来」。 */
function laterWrittenReads(segments: SegmentCard[]): Map<string, GraphHint[]> {
  const hints = new Map<string, GraphHint[]>()
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === undefined) continue
    const hit = seg.reads.some((path) =>
      segments.slice(i + 1).some((later) => later.writes.includes(path)),
    )
    if (hit) hints.set(seg.id, ['read_then_later_written'])
  }
  return hints
}

function applySimilarRetry(
  segments: SegmentCard[],
  rawById: Map<string, RawTurn>,
  laterWritten: Map<string, GraphHint[]>,
  resolved: Map<string, LabelDecision>,
): void {
  const threshold = similarRetryThreshold()
  if (threshold === undefined) return

  const groups = new Map<string, SegmentCard[]>()
  for (const seg of segments) {
    if (!isAction(seg) || seg.outcome !== 'error') continue
    const list = groups.get(seg.sig)
    if (list === undefined) groups.set(seg.sig, [seg])
    else list.push(seg)
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const remaining = [...group]
    while (remaining.length > 0) {
      const rep = remaining.shift()
      if (rep === undefined) break
      const members: SegmentCard[] = []
      const kept: SegmentCard[] = []
      for (const cand of remaining) {
        if (similarRetryMember(rep, cand, segments, rawById, threshold)) members.push(cand)
        else kept.push(cand)
      }
      remaining.length = 0
      remaining.push(...kept)
      if (members.length === 0) continue

      for (const member of members) {
        member.rep_of = rep.id
        resolved.set(
          member.id,
          decision(member.id, 'dead_end', RULE_SIMILAR_RETRY, laterWritten.get(member.id)),
        )
      }
      rep.rep_of = null
      if (!hasFollowup(rep, segments)) {
        resolved.set(rep.id, decision(rep.id, 'dead_end', RULE_SIMILAR_RETRY, laterWritten.get(rep.id)))
      }
    }
  }
}

function similarRetryMember(
  rep: SegmentCard,
  cand: SegmentCard,
  segments: SegmentCard[],
  rawById: Map<string, RawTurn>,
  threshold: number,
): boolean {
  if (jaccard(tokenSet(retryText(rep, rawById)), tokenSet(retryText(cand, rawById))) < threshold) {
    return false
  }
  const lo = indexOf(segments, rep.id)
  const hi = indexOf(segments, cand.id)
  if (lo < 0 || hi < 0 || hi <= lo) return false
  const between = segments.slice(lo + 1, hi)
  if (between.some((s) => s.writes.length > 0)) return false
  if (between.some((s) => isAction(s) && s.sig !== rep.sig)) return false
  return true
}

function applyRepeatRead(
  segments: SegmentCard[],
  laterWritten: Map<string, GraphHint[]>,
  resolved: Map<string, LabelDecision>,
): void {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === undefined || resolved.has(seg.id)) continue
    const repeatPaths = seg.reads.filter((path) => !seg.writes.includes(path))
    if (repeatPaths.length === 0) continue
    const isRepeat = repeatPaths.some((path) => {
      let seenRead = false
      for (let j = 0; j < i; j++) {
        const prev = segments[j]
        if (prev === undefined) continue
        if (prev.writes.includes(path)) seenRead = false
        if (prev.reads.includes(path) && !prev.writes.includes(path)) seenRead = true
      }
      return seenRead
    })
    if (!isRepeat) continue
    resolved.set(seg.id, decision(seg.id, 'routine', RULE_REPEAT_READ, laterWritten.get(seg.id)))
  }
}

function applyFailedCallNoFollowup(
  segments: SegmentCard[],
  laterWritten: Map<string, GraphHint[]>,
  resolved: Map<string, LabelDecision>,
): void {
  for (const seg of segments) {
    if (resolved.has(seg.id)) continue
    if (!isAction(seg) || seg.outcome !== 'error') continue
    if (hasFollowup(seg, segments)) continue
    resolved.set(
      seg.id,
      decision(seg.id, 'dead_end', RULE_FAILED_CALL_NO_FOLLOWUP, laterWritten.get(seg.id)),
    )
  }
}

/** 后续有写入或新动作 sig → 可能是有效探索，未决。纯思考/user 不算新 sig。 */
function hasFollowup(seg: SegmentCard, segments: SegmentCard[]): boolean {
  const start = indexOf(segments, seg.id)
  if (start < 0) return false
  for (const later of segments.slice(start + 1)) {
    if (later.writes.length > 0) return true
    if (isAction(later) && later.sig !== seg.sig) return true
  }
  return false
}

function isAction(seg: SegmentCard): boolean {
  return !NON_ACTION_TOOLS.has(seg.tool.toLowerCase())
}

function indexOf(segments: SegmentCard[], id: string): number {
  return segments.findIndex((s) => s.id === id)
}

function decision(
  segment_id: string,
  label: Label,
  rule_name: string,
  hints: GraphHint[] | undefined,
): LabelDecision {
  const d: LabelDecision = {
    segment_id,
    label,
    source: { kind: 'rule', name: rule_name },
    confidence: 1,
    rule_name,
  }
  if (hints !== undefined && hints.length > 0) d.graph_hints = hints
  return d
}

/** 阈值已拍板 0.8。非 [0,1] 有限数则跳过 similar_retry。 */
function similarRetryThreshold(): number | undefined {
  const t = SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD
  if (typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 1) return t
  return undefined
}

/** Jaccard 文本取自 tool_result 原文（缺则卡片 head）。 */
function retryText(seg: SegmentCard, rawById: Map<string, RawTurn>): string {
  for (const id of seg.raw_refs) {
    const turn = rawById.get(id)
    if (turn?.role === 'tool_result' && turn.content.length > 0) return turn.content
  }
  return seg.head
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/u).filter((t) => t.length > 0))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) {
    if (b.has(t)) inter += 1
  }
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
