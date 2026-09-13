/**
 * Pool-level token-budget alignment (ADR-0013 §3).
 * Aligns the *pool* to T, never by truncating a single trace mid-turns.
 */

/** T = min(pool_tokens) among included, non-skipped arms. */
export function choosePoolBudget(armPoolTokens: Record<string, number>): number {
  const values: number[] = []
  for (const n of Object.values(armPoolTokens)) {
    if (typeof n === 'number' && Number.isFinite(n)) values.push(n)
  }
  if (values.length === 0) {
    throw new Error('choosePoolBudget: no arm pool tokens')
  }
  return Math.min(...values)
}

/**
 * Greedy lexicographic subsample: keep whole traces, skip-and-continue if
 * the next would exceed T so later shorter traces can still fill.
 */
export function subsampleTraceIds(
  traces: Record<string, { tokens: number }>,
  budget: number,
): { selected: string[]; pool_tokens: number } {
  const ids = Object.keys(traces).sort(lexTraceId)
  const selected: string[] = []
  let pool_tokens = 0
  for (const id of ids) {
    const tokens = traces[id]?.tokens ?? 0
    if (!Number.isFinite(tokens) || tokens < 0) continue
    if (pool_tokens + tokens <= budget) {
      selected.push(id)
      pool_tokens += tokens
    }
  }
  return { selected, pool_tokens }
}

/** Deterministic Unicode code-point order (not locale-dependent). */
export function lexTraceId(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
