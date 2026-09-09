import type { LabelDecision } from '../../domain/label_decision'
import type { AgentView, Skeleton } from '../../types/agent_view'
import type { CutProfile } from '../../types/cut_profile'
import type { CutWarrant } from '../../types/cut_warrant'

export interface WriteWarrantInput {
  skeleton: Skeleton
  labels: LabelDecision[]
  view: AgentView
  profile: CutProfile
}

export function writeWarrant(_input: WriteWarrantInput): Promise<CutWarrant> {
  throw new Error('not implemented')
}
