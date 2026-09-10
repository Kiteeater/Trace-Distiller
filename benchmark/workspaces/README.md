# benchmark/workspaces

Real mini-repos for L4 replay. Bench maps `trace_id` → workspace via `manifest.json`, then materializes a **temp copy** so fixtures stay clean.

| workspace | bug | mapped tracks |
|-----------|-----|---------------|
| `add-fix` | `a - b` should be `a + b` | short / long / multi_dead_end samples that fix add.ts |
| `mul-fix` | `a + b` should be `a * b` | none yet (fixture ready) |

See each workspace README for mint requirements.
