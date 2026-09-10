import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FakeSessionBackend,
  setSessionBackend,
} from "../../src/agent/sessions/open_session.ts"
import { scoreSample } from "../../src/eval/benchmark.ts"
import { scoreKeptPathCoherence } from "../../src/eval/coherence.ts"
import { compressionScore } from "../../src/eval/metrics.ts"
import { runOptionalL4 } from "../../src/eval/run.ts"
import {
  disposeMaterializedWorkspace,
  materializeReplayWorkspace,
  resolveReplayWorkspace,
  runWorkspaceVerify,
  workspaceReady,
} from "../../src/eval/workspace.ts"
import { replay } from "../../src/eval/replay.ts"
import type { CutPlan, PlaybackCut } from "../../src/types/cut_plan.ts"
import type { IntentHypothesis, Skeleton } from "../../src/types/agent_view.ts"

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
      const broken = runWorkspaceVerify(work, resolved!.entry.verify ?? [])
      assert.equal(broken.ok, false, "fixture starts broken")
    } finally {
      disposeMaterializedWorkspace(work)
    }
  })

  it("fake L4 + real workspace heals, verify passes, composite > 0", async () => {
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
    assert.ok(l4.notes.some((n) => /deterministic workspace heal|verify ok/.test(n)), l4.notes.join("; "))
    assert.ok(l4.notes.some((n) => /verify ok/.test(n)), l4.notes.join("; "))

    const coh = await scoreKeptPathCoherence({
      kept_ids: ["s0017", "s0018"],
      cards: playback.cards,
      skeleton: { version: 0, nodes: [] } satisfies Skeleton,
    })
    assert.ok(coh.scores !== null && coh.scores.length > 0, coh.notes.join("; "))
    assert.ok(coh.scores!.every((s) => s >= 1 && s <= 5))

    const sample = scoreSample({
      bin: "short",
      trace_id: FLUFF_TRACE,
      compression_ratio: 0.062210456651224356,
      distill_cost_ratio: 0,
      kept: ["s0017", "s0018"],
      gold_segment_ids: ["s0017", "s0018"],
      replay: l4.replay,
      qa: l4.qa,
      coherence_scores: coh.scores,
      notes: [...l4.notes, ...coh.notes],
    })
    assert.equal(sample.metrics.replay.status, "pass")
    assert.equal(sample.metrics.compression_ratio.status, "pass")
    assert.equal(sample.metrics.coherence.status, "pass")
    assert.ok(sample.composite !== null)
    assert.ok(sample.composite! > 0)
    const expected = compressionScore(0.062210456651224356) * 1 * 1
    assert.equal(sample.composite, expected)
    assert.ok(sample.notes !== undefined && sample.notes.length > 0)
  })

  it("verify gate fails when fake claims success without heal", async () => {
    setSessionBackend(
      new FakeSessionBackend(() => ({
        text: JSON.stringify({ kind: "l4_replay_v0", success: true, note: "no heal" }),
        json: { kind: "l4_replay_v0", success: true, note: "no heal" },
        tool_calls: [],
        usage: { role: "l4_replay", input_tokens: 1, output_tokens: 1 },
      })),
    )
    const l4 = await runOptionalL4({
      intent: { version: 0, text: "Fix add" },
      playback: {
        trace_id: FLUFF_TRACE,
        plan_ref: "plan",
        cards: [card("s0017", "Edit", "x")],
        collapsed: [],
      },
      run_qa: false,
      run_replay: true,
      repo_root: repoRoot,
    })
    assert.equal(l4.replay, 0)
    assert.ok(l4.notes.some((n) => /verify failed|verify gate failed/.test(n)), l4.notes.join("; "))
  })

  it("qa parse failure is observable as qa=0 + note (not throw)", async () => {
    setSessionBackend(
      new FakeSessionBackend((input, opts) => {
        if (opts.role === "l4_qa") {
          return {
            text: "not-json",
            json: null,
            tool_calls: [],
            usage: { role: opts.role, input_tokens: 1, output_tokens: 1 },
          }
        }
        return {
          text: JSON.stringify({ kind: "l4_replay_v0", success: true, note: "x" }),
          json: { kind: "l4_replay_v0", success: true, note: "x" },
          tool_calls: [],
          usage: { role: opts.role, input_tokens: 1, output_tokens: 1 },
        }
      }),
    )
    const l4 = await runOptionalL4({
      intent: { version: 0, text: "Fix add" },
      playback: {
        trace_id: "unmapped-trace",
        plan_ref: "plan",
        cards: [],
        collapsed: [],
      },
      run_qa: true,
      run_replay: false,
      repo_root: repoRoot,
    })
    assert.equal(l4.qa, 0)
    assert.ok(l4.notes.some((n) => /qa failed/.test(n)), l4.notes.join("; "))
  })

  it("coherence failure notes when tool call missing", async () => {
    setSessionBackend(
      new FakeSessionBackend(() => ({
        text: "",
        json: null,
        tool_calls: [],
        usage: { role: "hole_b_label", input_tokens: 1, output_tokens: 1 },
      })),
    )
    const coh = await scoreKeptPathCoherence({
      kept_ids: ["s0017", "s0018"],
      cards: [card("s0017", "Edit", "a"), card("s0018", "Bash", "b")],
      skeleton: { version: 0, nodes: [] },
    })
    assert.equal(coh.scores, null)
    assert.ok(coh.notes.some((n) => /coherence failed/.test(n)), coh.notes.join("; "))
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
      const verified = runWorkspaceVerify(work, resolved!.entry.verify ?? [])
      assert.equal(verified.ok, true, verified.note)
    } finally {
      disposeMaterializedWorkspace(work)
    }
  })
})
