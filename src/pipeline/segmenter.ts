import { SEGMENT_HEAD_MAX_CHARS } from '../constant/window.ts'
import type { FocusLevel } from '../enums/focus.ts'
import type { AgentView } from '../types/agent_view.ts'
import type { RawTrace, RawTurn } from '../types/raw_trace.ts'
import type { SegmentCard, SegmentOutcome } from '../types/segment.ts'

const DEFAULT_FOCUS: FocusLevel = 'card'

const PATH_ARG_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** 确定性工具表：未知工具 reads/writes 为空。Bash 不从命令行猜路径。 */
const TOOL_IO: Record<string, { reads: boolean; writes: boolean }> = {
  read: { reads: true, writes: false },
  write: { reads: false, writes: true },
  edit: { reads: true, writes: true },
  notebookedit: { reads: true, writes: true },
}

const SIG_PATH_TOOLS = new Set(['read', 'edit', 'write'])
const SIG_BASH_TOOLS = new Set(['bash', 'shell'])

const TMP_PATH_RE =
  /(?:\/var\/folders\/\S+|\/var\/tmp\/\S+|\/tmp\/\S+|\$\{?(?:TMPDIR|TEMP|TMP)\}?(?:\/\S*)?)/gu

/**
 * L1 切段：一次工具调用 + 返回 = 一段；紧前 thinking 归这段；
 * 连续两次工具 = 两段；无后续工具的纯思考单独成段。
 * 不读 CutProfile，不按 token 窗口切。
 */
export function segment(raw: RawTrace): AgentView {
  const groups = groupTurns(raw.turns)
  return {
    meta: {
      trace_id: raw.meta.trace_id,
      source: raw.meta.source,
      ground_truth_ref: raw.meta.ground_truth_ref,
      total_tokens: raw.meta.total_tokens,
    },
    intent_hypothesis: { version: 0, text: '' },
    skeleton: { version: 0, nodes: [] },
    segments: groups.map((turns, index) => toCard(turns, index)),
  }
}

function groupTurns(turns: RawTurn[]): RawTurn[][] {
  const groups: RawTurn[][] = []
  let i = 0
  while (i < turns.length) {
    const prefix: RawTurn[] = []
    while (i < turns.length && turns[i]?.role === 'thought') {
      const thought = turns[i]
      if (thought !== undefined) prefix.push(thought)
      i += 1
    }

    let j = i
    while (j < turns.length && turns[j]?.role === 'assistant') j += 1
    if (turns[j]?.role === 'tool_call') {
      while (i < j) {
        const asst = turns[i]
        if (asst !== undefined) prefix.push(asst)
        i += 1
      }
    }

    const cur = turns[i]
    if (cur?.role === 'tool_call') {
      const unit = [...prefix, cur]
      i += 1
      while (i < turns.length) {
        const next = turns[i]
        if (next === undefined) break
        if (next.role === 'tool_result') {
          unit.push(next)
          i += 1
          break
        }
        if (next.role === 'tool_call' || next.role === 'user') break
        if (next.role === 'thought' || next.role === 'assistant') {
          unit.push(next)
          i += 1
          continue
        }
        break
      }
      groups.push(unit)
      continue
    }

    if (prefix.length > 0) {
      groups.push(prefix)
      continue
    }

    if (cur === undefined) break
    groups.push([cur])
    i += 1
  }
  return groups
}

function toCard(turns: RawTurn[], index: number): SegmentCard {
  const call = turns.find((t) => t.role === 'tool_call')
  const result = turns.find((t) => t.role === 'tool_result')
  const tool = call?.tool?.name ?? leadingRoleTool(turns)
  const args = parseArgs(call?.tool?.args_json)
  const { reads, writes } = extractPaths(tool, args)
  return {
    id: segmentId(index),
    tool,
    sig: buildSig(tool, args, call === undefined),
    outcome: outcomeOf(result),
    rep_of: null,
    reads,
    writes,
    tokens: turns.reduce((sum, t) => sum + t.tokens, 0),
    focus: DEFAULT_FOCUS,
    head: firstLineHead(turns.map((t) => t.content).join('\n')),
    raw_refs: turns.map((t) => t.id),
  }
}

function segmentId(index: number): string {
  return `s${String(index + 1).padStart(4, '0')}`
}

function leadingRoleTool(turns: RawTurn[]): string {
  const role = turns[0]?.role
  if (role === 'thought' || role === 'user' || role === 'assistant' || role === 'tool_result') {
    return role
  }
  return ''
}

function buildSig(tool: string, args: Record<string, unknown>, nonTool: boolean): string {
  if (nonTool) return tool
  const key = tool.toLowerCase()
  if (SIG_PATH_TOOLS.has(key)) {
    return `${tool}:${pathArg(args) ?? ''}`
  }
  if (SIG_BASH_TOOLS.has(key)) {
    const command = typeof args.command === 'string' ? args.command : primaryFingerprint(args)
    return `${tool}:${normalizeBash(command)}`
  }
  return `${tool}:${primaryFingerprint(args)}`
}

function extractPaths(
  tool: string,
  args: Record<string, unknown>,
): { reads: string[]; writes: string[] } {
  const spec = TOOL_IO[tool.toLowerCase()]
  if (spec === undefined) return { reads: [], writes: [] }
  const path = pathArg(args)
  if (path === undefined) return { reads: [], writes: [] }
  return {
    reads: spec.reads ? [path] : [],
    writes: spec.writes ? [path] : [],
  }
}

function pathArg(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function primaryFingerprint(args: Record<string, unknown>): string {
  const preferred = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'target']
  for (const key of preferred) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return collapseWs(value)
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === 'contents' || key === 'content' || key === 'old_string' || key === 'new_string') {
      continue
    }
    if (typeof value === 'string' && value.length > 0) return collapseWs(value)
  }
  return collapseWs(JSON.stringify(args))
}

function normalizeBash(command: string): string {
  return collapseWs(command.replace(TMP_PATH_RE, '<tmp>').replace(/\d+/gu, ''))
}

function collapseWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim()
}

function firstLineHead(text: string): string {
  const line = text.split(/\r?\n/u, 1)[0] ?? ''
  return line.slice(0, SEGMENT_HEAD_MAX_CHARS)
}

function outcomeOf(result: RawTurn | undefined): SegmentOutcome {
  if (result === undefined) return 'unknown'
  const code = parseExitCode(result.content, result.tool?.args_json)
  if (code === undefined) return 'unknown'
  return code === 0 ? 'ok' : 'error'
}

function parseExitCode(content: string, args_json: string | undefined): number | undefined {
  const tagged = content.match(/<exit_code>\s*(-?\d+)\s*<\/exit_code>/iu)
  if (tagged?.[1] !== undefined) return Number(tagged[1])
  const labeled = content.match(/\bexit(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/iu)
  if (labeled?.[1] !== undefined) return Number(labeled[1])
  const paren = content.match(/\(exit\s+(-?\d+)\)/iu)
  if (paren?.[1] !== undefined) return Number(paren[1])
  if (args_json !== undefined) {
    const args = parseArgs(args_json)
    if (typeof args.exitCode === 'number') return args.exitCode
    if (args.is_error === true) return 1
  }
  return undefined
}

function parseArgs(args_json: string | undefined): Record<string, unknown> {
  if (args_json === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(args_json)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
