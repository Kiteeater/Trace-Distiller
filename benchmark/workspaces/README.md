# benchmark/workspaces

Real mini-repos for L4 replay. Bench maps `trace_id` → workspace via `manifest.json`, then materializes a **temp copy** so fixtures stay clean.

| workspace | bug | mapped tracks |
|-----------|-----|---------------|
| `add-fix` | `a - b` should be `a + b` | short / long / multi_dead_end samples that fix add.ts |
| `mul-fix` | `a + b` should be `a * b` | `claude-code:sess-mul-fix` (fixture ready) |

## Unmapped traces (imported MIMO, etc.)

If `trace_id` is **not** in `manifest.json` `trace_map`, replay is **skipped** (`null`), not `fail=0`. Composite is not zeroed just because an imported sample has no fixture. Real mint replay still needs:

1. A mapped entry in `manifest.json`
2. Fixture files under `benchmark/workspaces/<dir>/`
3. `TRACE_DISTILLER_MODEL_L4` + coding tools
4. Optional `verify[]` hard gate after the model claims success

See each workspace README for mint requirements.
