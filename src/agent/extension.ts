/**
 * 蒸馏洞工具名单。
 *
 * 状态：DRAFT / 稍后拍板（docs/guides/tools.md 第一节）。
 * 本文件只导出常量，不实现 handler / 执行体，不挂 pi、不写 SQLite、不做 keep/drop。
 * 判断力工具只有两个；read_segment 是确定性取数，不是第三个判断力工具。
 */
export const HOLE_TOOL_STATUS = 'DRAFT' as const

export const HOLE_JUDGMENT_TOOL_NAMES = ['label_segment', 'check_continuity'] as const

export const HOLE_FETCH_TOOL_NAMES = ['read_segment'] as const

export const HOLE_TOOL_NAMES = [
  'label_segment',
  'check_continuity',
  'read_segment',
] as const

export type HoleJudgmentToolName = (typeof HOLE_JUDGMENT_TOOL_NAMES)[number]
export type HoleFetchToolName = (typeof HOLE_FETCH_TOOL_NAMES)[number]
export type HoleToolName = (typeof HOLE_TOOL_NAMES)[number]
