import type { FocusLevel } from '../enums/focus.ts'

export const SEGMENT_OUTCOMES = ['ok', 'error', 'unknown'] as const

export type SegmentOutcome = (typeof SEGMENT_OUTCOMES)[number]

export interface SegmentCard {
  id: string
  tool: string
  /**
   * 切段层生成：tool 名 + 规范化目标。
   * Read/Edit/Write → 路径；Bash → 去数字和临时路径后的命令模板；其它 → 主参数指纹。
   */
  sig: string
  outcome: SegmentOutcome
  /** 相似重试聚类：指向代表段 id；自己就是代表则为 null。rules 回填。 */
  rep_of: string | null
  reads: string[]
  writes: string[]
  tokens: number
  /** 默认档由规则代码决定，不是 LLM。未决 card；已决议噪音 line。 */
  focus: FocusLevel
  /** 原文截首句 / 首行，禁止 LLM 生成。 */
  head: string
  /** 指回 RawTrace 的 turn id，投影 Training Cut 用。 */
  raw_refs: string[]
}
