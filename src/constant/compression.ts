import { Label } from '../enums/label'

export const COMPRESSION_RATIO_TARGET = { min: 0.1, max: 0.3 } as const

export const DEFAULT_PROFILE_ID = 'default'

export const DEFAULT_KEEP_LABELS: Label[] = [Label.KeyDecision, Label.UsefulExploration]

export const DEFAULT_COLLAPSE_LABELS: Label[] = [Label.DeadEnd]

export const DEFAULT_DROP_LABELS: Label[] = [Label.Routine]
