import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FakeSessionBackend,
  setSessionBackend,
} from "../../src/agent/sessions/open_session.ts"
import { scoreSample } from "../../src/eval/benchmark.ts"
import { compressionScore } from "../../src/eval/metrics.ts"
import { runOptionalL4 } from "../../src/eval/run.ts"
import {
  disposeMaterializedWorkspace,
  materializeReplayWorkspace,
  resolveReplayWorkspace,
  workspaceReady,
} from "../../src/eval/workspace.ts"
import { replay } from "../../src/eval/replay.ts"
import type { CutPlan, PlaybackCut } from "../../src/types/cut_plan.ts"
import type { IntentHypothesis } from "../../src/types/agent_view.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
const FLUFF_TRACE = "claude-code:sess-short-fluff"

afterEach(() => {
  setSessionBackend(undefined)
})

function card(id: string, tool: string, head: string) {
  return {
    id,
    tool,
    sig: `${tool}:${id}`,
    outcome: "ok" as const,
    rep_of: null,
    reads: [] as string[],
    writes: [] as string[],
    tokens: 10,
    focus: "card" as const,
    head,
    raw_refs: [id],
  }
}

describe("real replay workspace wiring", () => {
  it("resolves add-fix fixture for short fluff / add-fix traces", () => {
    const resolved = resolveReplayWorkspace({ trace_id: FLUFF_TRACE, repo_root: repoRoot })
    assert.ok(resolved)
    assert.equal(resolved!.key, "add-fix")
    assert.ok(workspaceReady(resolved!.abs_dir, resolved!.entry.required_files))
    const work = materializeReplayWorkspace(resolved!.abs_dir)
    try {
      assert.ok(workspaceReady(work, resolved!.entry.required_files))
    } finally {
      disposeMaterializedWorkspace(work)
    }
  })

  it("fake L4 + real workspace yields replay=1 and composite > 0", async () => {
    setSessionBackend(new FakeSessionBackend())
    const intent: IntentHypothesis = {
      version: 0,
      text: "Fix add.ts so 1+1 equals 2; ignore noisy retries.",
    }
    const playback: PlaybackCut = {
      trace_id: FLUFF_TRACE,
      plan_ref: "plan",
      cards: [card("s0017", "Edit", "a - b -> a + b"), card("s0018", "Bash", "verify fix")],
      collapsed: [],
    }

    const l4 = await runOptionalL4({
      intent,
      playback,
      run_qa: true,
      run_replay: true,
      repo_root: repoRoot,
    })
    assert.equal(l4.replay, 1, `replay notes: ${l4.notes.join("; ")}`)
    assert.equal(l4.qa, 1)
    assert.ok(l4.notes.some((n) => /workspace cwd present|verify \(real mint\)/.test(n)))

    // fluff-heavy scoreboard path: compression already passes; only replay was zeroing composite.
    const sample = scoreSample({
      bin: "short",
      trace_id: FLUFF_TRACE,
      compression_ratio: 0.062210456651224356,
      distill_cost_ratio: 0,
      kept: ["s0017", "s0018"],
      gold_segment_ids: ["s0017", "s0018"],
      replay: l4.replay,
      qa: l4.qa,
      coherence_scores: [4, 5],
    })
    assert.equal(sample.metrics.replay.status, "pass")
    assert.equal(sample.metrics.compression_ratio.status, "pass")
    assert.ok(sample.composite !== null)
    assert.ok(sample.composite! > 0)
    const expected = compressionScore(0.062210456651224356) * 1 * 1
    assert.equal(sample.composite, expected)
  })

  it("eval.replay succeeds when cwd is the materialized fixture", async () => {
    const fake = new FakeSessionBackend()
    const resolved = resolveReplayWorkspace({
      trace_id: "claude-code:sess-no-llm",
      repo_root: repoRoot,
    })
    assert.ok(resolved)
    const work = materializeReplayWorkspace(resolved!.abs_dir)
    try {
      const plan: CutPlan = {
        trace_id: "claude-code:sess-no-llm",
        profile_id: "default",
        warrant_ref: "w",
        kept: ["s0006"],
        dropped: [],
        collapsed: [],
        span_ok: true,
        span_violations: [],
      }
      const out = await replay({ trace_id: "claude-code:sess-no-llm", text: "Fix add" }, plan, {
        cwd: work,
        backend: fake,
        playback: {
          trace_id: "claude-code:sess-no-llm",
          plan_ref: "w",
          cards: [],
          collapsed: [],
        },
      })
      assert.equal(out.success, true)
      assert.match(fake.calls[0]?.composed ?? "", /Work only inside cwd=/)
    } finally {
      disposeMaterializedWorkspace(work)
    }
  })
})
