export type TraceId = string

/** SWE-bench / pi-session 类型预留；MVP parser 只做 claude-code。 */
export type TraceSource = 'claude-code' | 'pi-session' | 'swebench'

export type GroundTruthKind = 'tests_passed' | 'task_confirmed'

export interface GroundTruth {
  kind: GroundTruthKind
  /** 指向原料里可独立核对的证据，不是 LLM 写的。口头「好了」单独出现不算。 */
  evidence_ref: string
}

export interface TraceMeta {
  trace_id: TraceId
  source: TraceSource
  ground_truth_ref: string
  /** 口径：RawTrace 原文 token（工具输出全文计入）。计数库选型 OPEN。 */
  total_tokens: number
}

export type RawTurnRole = 'thought' | 'tool_call' | 'tool_result' | 'user' | 'assistant'

export interface RawTurn {
  id: string
  role: RawTurnRole
  content: string
  tool?: { name: string; args_json: string }
  tokens: number
}

export interface RawTrace {
  meta: TraceMeta
  ground_truth: GroundTruth
  turns: RawTurn[]
  /** 洞 A 只读这些 id：任务前 1–2 轮 + GT 证据邻近 Action Unit。 */
  anchor_turn_ids: string[]
}

export const ADMISSION_ERROR_CODES = [
  'no_ground_truth',
  'unparseable',
  'multi_task_ambiguous',
] as const

export type AdmissionErrorCode = (typeof ADMISSION_ERROR_CODES)[number]

export interface AdmissionError {
  code: AdmissionErrorCode
  message: string
}
