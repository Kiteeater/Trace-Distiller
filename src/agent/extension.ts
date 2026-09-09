import type { Label } from '../enums/label'

export function label_segment(_args: {
  segment_id: string
  label: Label
  confidence: number
  rationale?: string
}): { ok: true } {
  throw new Error('not implemented')
}

export function check_continuity(_args: {
  left_id: string
  right_id: string
  reachable: boolean
  score: number
  reason: string
}): { ok: true } {
  throw new Error('not implemented')
}

export function read_segment(_args: { segment_id: string }): {
  segment_id: string
  focus: 'full'
  text: string
} {
  throw new Error('not implemented')
}
