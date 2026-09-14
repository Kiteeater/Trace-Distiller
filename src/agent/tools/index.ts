/**
 * Tool layer (ADR-0016): registry is the sole hole-tool entry.
 * pi symbols here: defineTool / ToolDefinition only. Session factory stays in sessions/.
 */
export {
  ackHoleTool,
  executeHoleTool,
  isHoleToolName,
  type HoleToolAck,
  type HoleToolDispatchContext,
  type HoleToolDispatchErr,
  type HoleToolDispatchOk,
  type HoleToolDispatchResult,
  type HoleToolName,
} from './registry.ts'
export {
  L4_REPLAY_CODING_TOOLS,
  buildHoleCustomTools,
  resolvePiToolRegistration,
  type PiToolRegistration,
} from './pi_tools.ts'
