import { createHash } from 'node:crypto'

/** 无状态 SHA-256 hex。给 trace_id；禁止用随机 UUID。 */
export function stableHash(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
