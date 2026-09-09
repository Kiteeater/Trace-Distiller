import type { AgentView } from '../types/agent_view'
import type { CutPlan, PlaybackCut, TrainingCut } from '../types/cut_plan'
import type { CutProfile } from '../types/cut_profile'
import type { CutWarrant } from '../types/cut_warrant'
import type { RawTrace } from '../types/raw_trace'

export interface AssembleInput {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  profile: CutProfile
  continuity?: Array<{ left: string; right: string; score: number; ok: boolean }>
}

export interface AssembleOutput {
  plan: CutPlan
  training: TrainingCut
  playback: PlaybackCut
}

export class SpanFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpanFailure'
  }
}

export function assemble(_input: AssembleInput): AssembleOutput {
  throw new Error('not implemented')
}
