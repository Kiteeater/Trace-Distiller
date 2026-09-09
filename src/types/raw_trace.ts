export type TraceId = string

/** Not an enum file yet; promote only via a new src/enums/trace_source.ts. */
export type TraceSource = 'claude-code' | 'pi-session' | 'swebench'

export type RawTurnRole = 'thought' | 'tool_call' | 'tool_result' | 'user' | 'assistant'

export interface GroundTruth {
  kind: 'tests_passed' | 'task_confirmed'
  evidence_ref: string
}

export interface TraceMeta {
  trace_id: TraceId
  source: TraceSource
  ground_truth_ref: string
  total_tokens: number
}

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
}
