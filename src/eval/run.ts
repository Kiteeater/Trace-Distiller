import { l4BackendAvailable } from '../agent/sessions/open_session.ts'
import { runQa, type QaItem } from '../agent/sessions/l4_qa.ts'
import { runReplay } from '../agent/sessions/l4_replay.ts'
import type { IntentHypothesis } from '../types/agent_view.ts'
import type { PlaybackCut } from '../types/cut_plan.ts'
import { qaRatio } from './metrics.ts'
import {
  disposeMaterializedWorkspace,
  materializeReplayWorkspace,
  resolveReplayWorkspace,
  workspaceReady,
} from './workspace.ts'

export { l4BackendAvailable }

export const L4_SKIP_NOTE =
  'skipped: no session backend (inject FakeSessionBackend or set TRACE_DISTILLER_MODEL_L4). Real replay success needs repo+model; CI only guarantees the interface'

export const L4_METRICS_ONLY_NOTE =
  'eval reads distill metrics from SQLite. Pass --qa / --replay to run L4 when a backend is available. L4 tokens are not distill cost'

export const L4_REPLAY_NO_WORKSPACE_NOTE =
  'replay failed: no mapped workspace under benchmark/workspaces (see manifest.json). Real mint needs a fixture repo + TRACE_DISTILLER_MODEL_L4 + coding tools'

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
      const out = await runQa({
        intent: input.intent,
        playback: input.playback,
        ...(input.questions !== undefined ? { questions: input.questions } : {}),
      })
      qa = qaRatio(out.score)
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
        replayScore = 0
      } else if (!workspaceReady(resolved.abs_dir, resolved.entry.required_files)) {
        notes.push(`replay failed: workspace not ready at ${resolved.abs_dir}`)
        replayScore = 0
      } else {
        const work = materializeReplayWorkspace(resolved.abs_dir)
        try {
          const taskText = input.intent.text || resolved.entry.task_hint || ''
          const out = await runReplay({
            task: {
              trace_id: input.playback.trace_id,
              text: taskText,
              cwd: work,
            },
            playback: input.playback,
            cwd: work,
          })
          replayScore = out.success ? 1 : 0
          if (out.note !== undefined) notes.push(`replay ${out.note}`)
          if (resolved.entry.verify !== undefined) {
            notes.push(`replay verify (real mint): ${resolved.entry.verify.join(' ')}`)
          }
        } finally {
          disposeMaterializedWorkspace(work)
        }
      }
    }
  }

  return { qa, replay: replayScore, notes }
}
