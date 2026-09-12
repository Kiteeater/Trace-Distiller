import type { RawTurn } from '../types/raw_trace.ts'

/**
 * ADR-0013 tools-only arm: keep first user + all tool_call/tool_result + the
 * single nearest preceding `thought` of each `tool_call` (no intervening
 * non-thought). Drop other thought / assistant / extra user. No Distiller labels.
 */
export function filterToolsOnly(turns: RawTurn[]): RawTurn[] {
  const keep = new Set<number>()
  const firstUser = turns.findIndex((t) => t.role === 'user')
  if (firstUser >= 0) keep.add(firstUser)

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]
    if (turn === undefined) continue
    if (turn.role === 'tool_call' || turn.role === 'tool_result') {
      keep.add(i)
    }
    if (turn.role !== 'tool_call' || i === 0) continue
    const prev = turns[i - 1]
    // Nearest left neighbor only: consecutive prefix thoughts collapse to the last one.
    if (prev?.role === 'thought') keep.add(i - 1)
  }

  const out: RawTurn[] = []
  for (let i = 0; i < turns.length; i += 1) {
    if (!keep.has(i)) continue
    const turn = turns[i]
    if (turn === undefined) continue
    out.push(cloneTurn(turn))
  }
  return out
}

export function cloneTurn(turn: RawTurn): RawTurn {
  const next: RawTurn = {
    id: turn.id,
    role: turn.role,
    content: turn.content,
    tokens: turn.tokens,
  }
  if (turn.tool !== undefined) {
    next.tool = { name: turn.tool.name, args_json: turn.tool.args_json }
  }
  return next
}
