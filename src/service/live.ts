import type { PlaybackCut } from '../types/cut_plan'
import type { CutWarrant } from '../types/cut_warrant'

export type DistillJobId = string

export interface DistillJobSummary {
  id: DistillJobId
}

/** Field-level progress schema OPEN (docs/guides/tools.md). */
export interface CutProgress {
  job_id: DistillJobId
}

export function listJobs(): DistillJobSummary[] {
  throw new Error('not implemented')
}

export function attachJob(_id: DistillJobId): void {
  throw new Error('not implemented')
}

export function detachJob(_id: DistillJobId): void {
  throw new Error('not implemented')
}

export function getCutProgress(_id: DistillJobId): CutProgress {
  throw new Error('not implemented')
}

export function getPartialResult(_id: DistillJobId): PlaybackCut {
  throw new Error('not implemented')
}

export function getWarrantTail(_id: DistillJobId): CutWarrant {
  throw new Error('not implemented')
}
