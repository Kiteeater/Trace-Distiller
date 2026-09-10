# add-fix replay workspace

Tiny real repo for L4 replay (not a synthetic success stub).

- Starts **broken**: `add.ts` uses `a - b`.
- Task: fix so `1+1` equals `2`, then pass `tests/test_add.py`.
- Mapped from short-bench traces `claude-code:sess-no-llm` and `claude-code:sess-short-fluff`.

## Real mint (production L4)

1. Set `TRACE_DISTILLER_MODEL_L4` (+ gateway `TRACE_DISTILLER_API_BASE` / `TRACE_DISTILLER_API_KEY`).
2. `bench` (without `--no-llm`) resolves this workspace, copies it to a temp cwd, and opens `l4_replay` with coding tools (`read` / `bash` / `edit` / `write`) rooted there.
3. Model follows the distilled playback path, edits `add.ts`, runs `python3 tests/test_add.py`, then replies with `l4_replay_v0` JSON `{ success: true }`.
4. **Post-replay verify gate**: Distiller re-runs `manifest.verify` in the temp cwd. Model claim without a green verify → `replay=0` + observable note.

## Fake L4 (CI / local, hang-free)

```bash
node --experimental-strip-types script/run-distill.ts bench --no-llm --fake-l4
```

`--fake-l4` injects `FakeSessionBackend`, which applies a **deterministic heal** (`a - b` → `a + b`) so the verify gate can pass. That proves the scoreboard path can yield **composite > 0**; it does **not** claim mint fidelity.

`--no-llm` without `--fake-l4` skips real L4 entirely (avoids mint hangs when env models are set).
