# Long-track web sources

## mimo-claude-code-traces-1k

- Upstream: [choucsan/mimo-claude-code-traces-1k](https://huggingface.co/datasets/choucsan/mimo-claude-code-traces-1k) (also [GitHub mirror](https://github.com/choucisan/mimo-claude-code-traces-1k); session JSONL live on HF)
- License: **MIT** (upstream LICENSE)
- Generator model: mimo-v2.5-pro in a Claude Code-style harness
- Local files (adapted, no secrets):
  - `mimo-debug-stats.jsonl` ← `session/debugging/7201fdae.jsonl`
  - `mimo-algo-174fc63f.jsonl` ← `session/algorithms/174fc63f.jsonl`
  - `mimo-debug-parse.jsonl` ← `session/debugging/8c09ef71.jsonl`
- Adaptation: prepend explicit `ground_truth` (`task_confirmed`) + `distiller_meta` so Admission Gate accepts sessions that lack a test-tool exit; remap `sessionId`; do **not** invent tool transcripts. Key-decision gold is rough / optional (see `*.key-decisions.json`).
- Cost / L4 tokens: unchanged — distill cost still excludes L4.
