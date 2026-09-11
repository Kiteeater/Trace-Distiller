# Long-track web sources

## mimo-claude-code-traces-1k

- Upstream: [choucsan/mimo-claude-code-traces-1k](https://huggingface.co/datasets/choucsan/mimo-claude-code-traces-1k) (also [GitHub mirror](https://github.com/choucisan/mimo-claude-code-traces-1k); session JSONL live on HF)
- License: **MIT** (upstream LICENSE)
- Generator model: mimo-v2.5-pro in a Claude Code-style harness
- Local files (adapted, no secrets):
  - `mimo-debug-stats.jsonl` ← `session/debugging/7201fdae.jsonl`
  - `mimo-algo-174fc63f.jsonl` ← `session/algorithms/174fc63f.jsonl`
  - `mimo-debug-parse.jsonl` ← `session/debugging/8c09ef71.jsonl`
  - `mimo-debug-hang.jsonl` ← `session/debugging/f221415e.jsonl` (hang bug; retries / dead-ends)
  - `mimo-debug-minmax.jsonl` ← `session/debugging/d307bfb5.jsonl` (stats debug; failed probes then fix)
  - `mimo-shell-cicd.jsonl` ← `session/shell_devops/8d031bf8.jsonl` (CI/CD; tool error attempts)
  - `mimo-refactor-decorator.jsonl` ← `session/refactoring/03c7ff2d.jsonl` (decorator refactor; recovery after tool error)
- Adaptation: prepend explicit `ground_truth` (`task_confirmed`) + `distiller_meta` so Admission Gate accepts sessions that lack a test-tool exit; remap `sessionId`; do **not** invent tool transcripts. Key-decision gold is rough / optional (see `*.key-decisions.json`).
- Cost / L4 tokens: unchanged — distill cost still excludes L4.
- Prefer traces with failed tool/tests then recovery for long-context dead-end coverage.

## Replay fixtures

These MIMO imports are **not** mapped in `benchmark/workspaces/manifest.json` by default.
Bench treats unmapped replay as **skipped** (`null`), not fail=0 — real replay still needs a mapped fixture (e.g. add-fix / mul-fix) when intent matches.

