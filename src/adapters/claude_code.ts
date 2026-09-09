import type { RawTrace, TraceSource } from '../types/raw_trace'

export type AdmissionErrorCode = 'no_ground_truth' | 'unparseable' | 'multi_task_ambiguous'

export class AdmissionError extends Error {
  readonly code: AdmissionErrorCode

  constructor(code: AdmissionErrorCode, message: string) {
    super(message)
    this.name = 'AdmissionError'
    this.code = code
  }
}

export interface Adapter {
  source: TraceSource
  sniff(input: unknown): boolean
  parse(input: unknown): RawTrace
}

export const source: TraceSource = 'claude-code'

export function sniff(_input: unknown): boolean {
  throw new Error('not implemented')
}

export function parse(_input: unknown): RawTrace {
  throw new Error('not implemented')
}

export function loadRawTrace(_path: string, _source?: TraceSource): RawTrace {
  throw new Error('not implemented')
}
