# add-fix replay workspace

Tiny real repo for L4 replay (not a synthetic success stub).

- Starts **broken**: `add.ts` uses `a - b`.
- Task: fix so `1+1` equals `2`, then pass `tests/test_add.py`.
- Mapped from short-bench traces `claude-code:sess-no-llm` and `claude-code:sess-short-fluff`.

## Real mint (production L4)

1. Set `TRACE_DISTILLER_MODEL_L4` (+ gateway `TRACE_DISTILLER_API_BASE` / `TRACE_DISTILLER_API_KEY`).
2. `bench` resolves this workspace, copies it to a temp cwd, and opens `l4_replay` with coding tools (`read` / `bash` / `edit` / `write`) rooted there.
3. Model follows the distilled playback path, edits `add.ts`, runs `python3 tests/test_add.py`, then replies with `l4_replay_v0` JSON `{ success: true }`.

Unit tests inject `FakeSessionBackend`: success when the materialized cwd exists (no real edit). That is enough to prove the scoreboard path can yield **composite > 0**; it does not claim mint fidelity.
