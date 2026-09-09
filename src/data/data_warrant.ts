import type { CutPlan } from '../types/cut_plan'
import type { CutWarrant } from '../types/cut_warrant'
import type { Db } from './data_segment'

export function insertWarrant(_db: Db, _warrant: CutWarrant): void {
  throw new Error('not implemented')
}

export function insertCutPlan(_db: Db, _plan: CutPlan): void {
  throw new Error('not implemented')
}
