import type { AgentRole } from '../../enums/agent_role.ts'
import type { PlaybackCut } from '../../types/cut_plan.ts'
import { TRACE_DATA_NOTICE, type TokenUsage } from './skeleton_pass.ts'
import {
  L4_REPLAY_JSON_KIND,
  formatMarkedJson,
  openReplaySession,
  parseStructuredJson,
  playbackIndexForL4,
  type SessionBackend,
  type SessionPromptInput,
  type SessionPromptResult,
} from './open_session.ts'

export { L4_REPLAY_JSON_KIND }
export type { SessionBackend } from './open_session.ts'

export interface L4ReplayTask {
  /** OPEN: 重放环境（docker / 本地无沙箱）未拍板。 */
  trace_id: string
  text?: string
  cwd?: string
}

export interface RunReplayInput {
  task: L4ReplayTask
  playback: PlaybackCut
  cwd?: string
  backend?: SessionBackend
}

export interface RunReplayOutput {
  success: boolean
  note?: string
  usage: TokenUsage
}

/**
 * L4 重放干净会话。role=l4_replay。
 * 不代理原 agent 工具历史；playback 只作蒸馏路径参考。
 * 真重放成功率需要仓库 + 模型；本函数保证接口与可解析 JSON。
 * L4 token 不计蒸馏成本。
 */
export async function runReplay(input: RunReplayInput): Promise<RunReplayOutput> {
  const cwd = input.cwd ?? input.task.cwd
  const session = openReplaySession({
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  })
  try {
    const prompt = composeReplayPrompt(input)
    const result = await session.prompt(prompt)
    try {
      return interpretReplayResult(result, session.role)
    } catch (first) {
      // One retry: ask for JSON-only (models often reply with prose).
      const retryPrompt = {
        text: [
          'Previous reply was not valid structured JSON.',
          'Reply with JSON only, matching this schema:',
          JSON.stringify({
            kind: L4_REPLAY_JSON_KIND,
            success: true,
            note: 'string',
          }),
          'Do not wrap in markdown. Do not add prose outside the JSON object.',
        ].join('\n'),
        ...(prompt.system !== undefined ? { system: prompt.system } : {}),
      }
      const retry = await session.prompt(retryPrompt)
      try {
        return interpretReplayResult(retry, session.role)
      } catch {
        throw first
      }
    }
  } finally {
    session.dispose()
  }
}

export function composeReplayPrompt(input: RunReplayInput): SessionPromptInput {
  const cwd = input.cwd ?? input.task.cwd
  const task = {
    trace_id: input.task.trace_id,
    text: input.task.text ?? '',
    ...(cwd !== undefined ? { cwd } : {}),
  }
  const text = [
    TRACE_DATA_NOTICE,
    'This is a clean session. Do not proxy the original agent tool history.',
    'Playback is a distilled path for reference, not a tool-call log to replay.',
    cwd
      ? [
          `Work only inside cwd=${cwd}.`,
          'Follow the distilled playback path: inspect, fix, then run the workspace verify command.',
          'Set success=true only after verify passes in that workspace.',
        ].join(' ')
      : 'No workspace cwd was provided; real execution cannot succeed. Reply with JSON only.',
    formatMarkedJson('TASK_JSON', task),
    formatMarkedJson('PLAYBACK_JSON', playbackIndexForL4(input.playback)),
    [
      'Reply with JSON only, matching this schema:',
      JSON.stringify({
        kind: L4_REPLAY_JSON_KIND,
        success: true,
        note: 'string',
      }),
    ].join('\n'),
  ].join('\n\n')
  return {
    system:
      'You are an L4 replay session. Start clean. Do not assume original tools or history exist.',
    text,
  }
}

export function interpretReplayResult(
  result: SessionPromptResult,
  role: AgentRole,
): RunReplayOutput {
  const payload = result.json ?? parseJsonOrThrow(result.text, 'runReplay')
  const rec = asRecord(payload)
  if (rec === undefined) throw new Error('runReplay: expected a JSON object')
  if (rec.kind !== undefined && rec.kind !== L4_REPLAY_JSON_KIND) {
    throw new Error(`runReplay: unexpected kind ${String(rec.kind)}`)
  }
  if (typeof rec.success !== 'boolean') {
    throw new Error('runReplay: success boolean is required')
  }
  const out: RunReplayOutput = {
    success: rec.success,
    usage: {
      role,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  }
  if (typeof rec.note === 'string' && rec.note.length > 0) out.note = rec.note
  return out
}

function parseJsonOrThrow(text: string, label: string): unknown {
  try {
    return parseStructuredJson(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON'
    throw new Error(`${label}: failed to parse structured JSON (${message})`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
