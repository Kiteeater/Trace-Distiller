/**
 * ADR-0011 洞 A 分层候选池：算法锚点 + 分层随机补齐（非纯随机、非用户手挑）。
 */
import {
  SPARSE_INTENT_FAILURE_DENSE_MIN,
  SPARSE_INTENT_FAILURE_WINDOW,
  SPARSE_INTENT_HEAD_SEGMENTS,
} from '../../constant/window.ts'
import type { AgentView } from '../../types/agent_view.ts'
import type { RawTrace } from '../../types/raw_trace.ts'
import type { SegmentCard } from '../../types/segment.ts'

export const CANDIDATE_STRATA = [
  'head',
  'verification',
  'error_retry',
  'tool_failure_dense',
  'random_fill',
] as const

export type CandidateStratum = (typeof CANDIDATE_STRATA)[number]

export interface CandidateEntry {
  segment_id: string
  stratum: CandidateStratum
  /** 采样权重；gaps 命中时可临时抬高。 */
  weight: number
}

export interface SparseGap {
  /** 人类可读缺口说明。 */
  hint: string
  /** 优先再读的 segment id。 */
  segment_ids?: string[]
  /** 优先再采的分层。 */
  strata?: CandidateStratum[]
  weight?: number
}

export interface BuildCandidatePoolInput {
  view: AgentView
  raw: RawTrace
  head_turn_ids?: readonly string[]
  verification_turn_ids?: readonly string[]
}

const STRATUM_BASE_WEIGHT: Record<CandidateStratum, number> = {
  head: 4,
  verification: 4,
  error_retry: 3,
  tool_failure_dense: 3,
  random_fill: 1,
}

/**
 * 构建分层候选池。每个 segment 只保留最高优先级分层（head > verification >
 * error_retry > tool_failure_dense > random_fill）。
 */
export function buildCandidatePool(input: BuildCandidatePoolInput): CandidateEntry[] {
  const segments = input.view.segments
  if (segments.length === 0) return []

  const headTurns = new Set(input.head_turn_ids ?? [])
  const verTurns = new Set(input.verification_turn_ids ?? [])
  if (headTurns.size === 0 && verTurns.size === 0) {
    for (const id of deriveDefaultHeadTurnIds(input.raw)) headTurns.add(id)
    for (const id of input.raw.anchor_turn_ids) {
      if (!headTurns.has(id)) verTurns.add(id)
    }
  }

  const headSegs = new Set<string>()
  const verSegs = new Set<string>()
  for (const seg of segments) {
    if (seg.raw_refs.some((r) => headTurns.has(r))) headSegs.add(seg.id)
    if (seg.raw_refs.some((r) => verTurns.has(r))) verSegs.add(seg.id)
  }
  // 头段兜底：前 N 个 segment
  for (let i = 0; i < Math.min(SPARSE_INTENT_HEAD_SEGMENTS, segments.length); i += 1) {
    const id = segments[i]?.id
    if (id !== undefined) headSegs.add(id)
  }

  const errorRetry = new Set<string>()
  for (const seg of segments) {
    if (seg.outcome === 'error') errorRetry.add(seg.id)
    if (seg.rep_of !== null) {
      errorRetry.add(seg.id)
      errorRetry.add(seg.rep_of)
    }
  }

  const failureDense = findToolFailureDense(segments)

  const best = new Map<string, CandidateStratum>()
  const rank = (s: CandidateStratum): number => CANDIDATE_STRATA.indexOf(s)

  const assign = (id: string, stratum: CandidateStratum): void => {
    const prev = best.get(id)
    if (prev === undefined || rank(stratum) < rank(prev)) best.set(id, stratum)
  }

  for (const id of headSegs) assign(id, 'head')
  for (const id of verSegs) assign(id, 'verification')
  for (const id of errorRetry) assign(id, 'error_retry')
  for (const id of failureDense) assign(id, 'tool_failure_dense')
  for (const seg of segments) {
    if (!best.has(seg.id)) assign(seg.id, 'random_fill')
  }

  return segments.map((seg) => {
    const stratum = best.get(seg.id) ?? 'random_fill'
    return {
      segment_id: seg.id,
      stratum,
      weight: STRATUM_BASE_WEIGHT[stratum],
    }
  })
}

/**
 * 从未读候选中按权重抽样。gaps.segment_ids / strata 抬权。
 * 不是纯随机：锚点层权重大于 random_fill；gaps 再加权。
 */
export function sampleCandidates(
  pool: readonly CandidateEntry[],
  opts: {
    already_read: ReadonlySet<string>
    count: number
    gaps?: readonly SparseGap[]
    /** 可注入 RNG（测试）；默认 Math.random。 */
    rng?: () => number
  },
): string[] {
  const rng = opts.rng ?? Math.random
  const gapIds = new Set<string>()
  const gapStrata = new Set<CandidateStratum>()
  let gapBoost = 2
  for (const g of opts.gaps ?? []) {
    for (const id of g.segment_ids ?? []) gapIds.add(id)
    for (const s of g.strata ?? []) gapStrata.add(s)
    if (typeof g.weight === 'number' && Number.isFinite(g.weight) && g.weight > 0) {
      gapBoost = Math.max(gapBoost, g.weight)
    }
  }

  const available = pool
    .filter((e) => !opts.already_read.has(e.segment_id))
    .map((e) => {
      let w = e.weight
      if (gapIds.has(e.segment_id)) w *= gapBoost * 2
      else if (gapStrata.has(e.stratum)) w *= gapBoost
      return { id: e.segment_id, weight: w }
    })

  // 先保证 gaps 显式 id 尽量入选
  const picked: string[] = []
  const pickedSet = new Set<string>()
  for (const id of gapIds) {
    if (picked.length >= opts.count) break
    if (opts.already_read.has(id)) continue
    if (!pool.some((e) => e.segment_id === id)) continue
    picked.push(id)
    pickedSet.add(id)
  }

  const rest = available.filter((a) => !pickedSet.has(a.id))
  while (picked.length < opts.count && rest.length > 0) {
    const total = rest.reduce((s, a) => s + a.weight, 0)
    if (total <= 0) break
    let r = rng() * total
    let idx = 0
    for (let i = 0; i < rest.length; i += 1) {
      r -= rest[i]!.weight
      if (r <= 0) {
        idx = i
        break
      }
      idx = i
    }
    const chosen = rest.splice(idx, 1)[0]!
    picked.push(chosen.id)
  }
  return picked
}

export function deriveDefaultHeadTurnIds(raw: RawTrace): string[] {
  const firstUser = raw.turns.find((t) => t.role === 'user')
  if (firstUser === undefined) return []
  const idx = raw.turns.findIndex((t) => t.id === firstUser.id)
  const out: string[] = []
  const first = raw.turns[idx]
  const second = raw.turns[idx + 1]
  if (first !== undefined) out.push(first.id)
  if (second !== undefined) out.push(second.id)
  return out
}

function findToolFailureDense(segments: readonly SegmentCard[]): Set<string> {
  const dense = new Set<string>()
  const n = segments.length
  const w = SPARSE_INTENT_FAILURE_WINDOW
  for (let i = 0; i < n; i += 1) {
    let errors = 0
    const end = Math.min(n, i + w)
    for (let j = i; j < end; j += 1) {
      if (segments[j]?.outcome === 'error') errors += 1
    }
    if (errors >= SPARSE_INTENT_FAILURE_DENSE_MIN) {
      for (let j = i; j < end; j += 1) {
        const id = segments[j]?.id
        if (id !== undefined) dense.add(id)
      }
    }
  }
  return dense
}
