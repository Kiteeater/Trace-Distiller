import type { LabelDecision } from '../domain/label_decision'
import type { AgentView } from '../types/agent_view'
import type { RawTrace } from '../types/raw_trace'

export interface FileDepGraph {
  nodes: string[]
  edges: Array<{ path: string; segment_id: string; op: 'read' | 'write' }>
}

export interface RulesInput {
  view: AgentView
  raw: RawTrace
}

export interface RulesOutput {
  view: AgentView
  decisions: LabelDecision[]
  unresolved_ids: string[]
  graph: FileDepGraph
}

export function applyRules(_input: RulesInput): RulesOutput {
  throw new Error('not implemented')
}
