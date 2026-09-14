/**
 * Shim (ADR-0016): hole customTools live in `src/agent/tools/`.
 * Registry is the sole dispatch entry; this path re-exports for old imports.
 */
export {
  L4_REPLAY_CODING_TOOLS,
  buildHoleCustomTools,
  resolvePiToolRegistration,
} from '../tools/pi_tools.ts'
export type { PiToolRegistration } from '../tools/pi_tools.ts'
