import type { AgentView } from '../types/agent_view'
import type { RawTrace } from '../types/raw_trace'

export interface SegmenterInput {
  raw: RawTrace
}

export interface SegmenterOutput {
  view: AgentView
}

export function segment(_input: SegmenterInput): SegmenterOutput {
  throw new Error('not implemented')
}
