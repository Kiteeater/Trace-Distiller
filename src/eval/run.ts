import { l4BackendAvailable } from '../agent/sessions/open_session.ts'
import { runQa, type QaItem } from '../agent/sessions/l4_qa.ts'
import { runReplay } from '../agent/sessions/l4_replay.ts'
import type { IntentHypothesis } from '../types/agent_view.ts'
import type { PlaybackCut } from '../types/cut_plan.ts'
import { qaRatio } from './metrics.ts'

export { l4BackendAvailable }

export const L4_SKIP_NOTE =
  'skipped: no session backend (inject FakeSessionBackend or set TRACE_DISTILLER_MODEL_L4). Real replay success needs repo+model; CI only guarantees the interface'

export const L4_METRICS_ONLY_NOTE =
  'eval reads distill metrics from SQLite. Pass --qa / --replay to run L4 when a backend is available. L4 tokens are not distill cost'

export interface OptionalL4Input {
  intent: IntentHypothesis
  playback: PlaybackCut
  run_qa: boolean
  run_replay: boolean
  questions?: QaItem[]
}

export interface OptionalL4Result {
  qa: number | null
  replay: number | null
  notes: string[]
}

/**
 * CLI eval 的 L4 开关。无后端则跳过并注明，不假装跑过。
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
      const out = await runReplay({
        task: { trace_id: input.playback.trace_id, text: input.intent.text },
        playback: input.playback,
      })
      replayScore = out.success ? 1 : 0
    }
  }

  return { qa, replay: replayScore, notes }
}
