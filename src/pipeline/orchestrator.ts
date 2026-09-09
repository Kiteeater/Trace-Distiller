import type { AgentView } from '../types/agent_view'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan'
import type { CutProfile } from '../types/cut_profile'
import type { CutWarrant } from '../types/cut_warrant'
import type { RawTrace } from '../types/raw_trace'

export interface DistillInput {
  raw: RawTrace
  profile: CutProfile
}

export interface DistillResult {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  plan: CutPlan
  training?: TrainingCut
  playback?: PlaybackCut
  metrics_ref: string
}

export function distill(_input: DistillInput): Promise<DistillResult> {
  throw new Error('not implemented')
}
