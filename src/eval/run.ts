import { l4BackendAvailable, hasInjectedSessionBackend } from '../agent/sessions/open_session.ts'
import { runQa, type QaItem } from '../agent/sessions/l4_qa.ts'
import { runReplay } from '../agent/sessions/l4_replay.ts'
import type { IntentHypothesis } from '../types/agent_view.ts'
import type { PlaybackCut } from '../types/cut_plan.ts'
import { qaRatio } from './metrics.ts'
import {
  disposeMaterializedWorkspace,
  materializeReplayWorkspace,
  resolveReplayWorkspace,
  runWorkspaceVerify,
  workspaceReady,
} from './workspace.ts'

export { l4BackendAvailable }

export const L4_SKIP_NOTE =
  'skipped: no session backend (inject FakeSessionBackend or set TRACE_DISTILLER_MODEL_L4). Real replay success needs repo+model; CI only guarantees the interface'

export const L4_METRICS_ONLY_NOTE =
  'eval reads distill metrics from SQLite. Pass --qa / --replay to run L4 when a backend is available. L4 tokens are not distill cost'

export const L4_REPLAY_NO_WORKSPACE_NOTE =
  'replay skipped: no mapped workspace under benchmark/workspaces (see manifest.json). Real replay needs a mapped fixture + TRACE_DISTILLER_MODEL_L4 + coding tools; imported MIMO traces without a fixture are skipped (null), not fail=0'

export interface OptionalL4Input {
  intent: IntentHypothesis
  playback: PlaybackCut
  run_qa: boolean
  run_replay: boolean
  questions?: QaItem[]
  /** Repo root for benchmark/workspaces resolution. Defaults to process.cwd(). */
  repo_root?: string
}

export interface OptionalL4Result {
  qa: number | null
  replay: number | null
  notes: string[]
}

/**
 * CLI eval 的 L4 开关。无后端则跳过并注明，不假装跑过。
 * Replay：若 manifest 映射到真实小仓，则物化临时 cwd 再跑 runReplay。
 * 无 mapped workspace → replay skipped (null)，不因缺 fixture 把 composite 归零。
 * QA 0/0 → skipped；QA 重试后仍无合法 pairs → skipped（不是 fail=0）。
 * replay 解析失败但 workspace verify 通过则可恢复 success。
 * 有 verify[] 时成功后硬跑闸门；失败则 replay=0。
 */
export async function runOptionalL4(input: OptionalL4Input): Promise<OptionalL4Result> {
  const notes: string[] = []
  let qa: number | null = null
  let replayScore: number | null = null
  const available = l4BackendAvailable()

  if (input.run_qa) {
    if (!available) {
      notes.push(`qa ${L4_SKIP_NOTE}`)
    } else {
      try {
        const out = await runQa({
          intent: input.intent,
          playback: input.playback,
          ...(input.questions !== undefined ? { questions: input.questions } : {}),
        })
        qa = qaRatio(out.score)
        if (qa === null) {
          notes.push(
            `qa skipped: correct=${out.score.correct}/${out.score.answered} (no questions answered)`,
          )
        } else if (qa < 1) {
          notes.push(`qa partial: correct=${out.score.correct}/${out.score.answered}`)
        }
      } catch (err) {
        const msg = errMessage(err)
        // Zero valid pairs after retries → skip (null), do not zero composite.
        if (isQaUnparseableOrEmpty(msg)) {
          qa = null
          notes.push(`qa skipped: unparseable after retries (${msg})`)
        } else {
          qa = 0
          notes.push(`qa failed: ${msg}`)
        }
      }
    }
  }

  if (input.run_replay) {
    if (!available) {
      notes.push(`replay ${L4_SKIP_NOTE}`)
    } else {
      const repoRoot = input.repo_root ?? process.cwd()
      const resolved = resolveReplayWorkspace({
        trace_id: input.playback.trace_id,
        repo_root: repoRoot,
      })
      if (resolved === null) {
        notes.push(L4_REPLAY_NO_WORKSPACE_NOTE)
        replayScore = null
      } else if (!workspaceReady(resolved.abs_dir, resolved.entry.required_files)) {
        notes.push(`replay failed: workspace not ready at ${resolved.abs_dir}`)
        replayScore = 0
      } else {
        const work = materializeReplayWorkspace(resolved.abs_dir)
        try {
          const taskText = input.intent.text || resolved.entry.task_hint || ''
          let modelSuccess = false
          try {
            const out = await runReplay({
              task: {
                trace_id: input.playback.trace_id,
                text: taskText,
                cwd: work,
              },
              playback: input.playback,
              cwd: work,
            })
            modelSuccess = out.success
            if (out.note !== undefined) notes.push(`replay ${out.note}`)
          } catch (err) {
            modelSuccess = false
            notes.push(`replay failed: ${errMessage(err)}`)
          }

          const verifyArgv = resolved.entry.verify
          if (verifyArgv !== undefined && verifyArgv.length > 0) {
            const verified = runWorkspaceVerify(work, verifyArgv)
            notes.push(`replay ${verified.note}`)
            if (verified.ok) {
              // Workspace verify is the hard gate: recover success when JSON/parse failed
              // but tests already passed (common mint L4 prose failure mode).
              if (!modelSuccess) {
                notes.push(
                  'replay recovered: workspace verify passed despite model/parse failure',
                )
              }
              replayScore = 1
            } else {
              replayScore = 0
              if (modelSuccess) {
                notes.push(
                  hasInjectedSessionBackend()
                    ? 'replay verify gate failed after fake claim (composite replay=0)'
                    : 'replay verify gate failed after model claim (real mint must pass tests)',
                )
              }
            }
          } else {
            replayScore = modelSuccess ? 1 : 0
            notes.push(
              'replay verify skipped: no verify[] in workspace manifest (document real mint verify locally)',
            )
          }
        } finally {
          disposeMaterializedWorkspace(work)
        }
      }
    }
  }

  return { qa, replay: replayScore, notes }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Parse/empty failures with zero valid QA pairs — prefer skip over fail=0. */
function isQaUnparseableOrEmpty(message: string): boolean {
  return (
    /failed to parse structured JSON/i.test(message) ||
    /items\[\] is empty/i.test(message) ||
    /items\[\] is required/i.test(message) ||
    /expected a JSON object/i.test(message)
  )
}
