# Multi-dead-end track sources

## mimo-claude-code-traces-1k

- Upstream: [choucsan/mimo-claude-code-traces-1k](https://huggingface.co/datasets/choucsan/mimo-claude-code-traces-1k) (MIT)
- Local files (adapted, no secrets):
  - `mimo-debug-validate.jsonl` ← `session/debugging/5bf7187b.jsonl` (validate-input debug; multiple `is_error` tool results then recovery)
  - `mimo-shell-health.jsonl` ← `session/shell_devops/ef55c733.jsonl` (health monitor script; failish retries / dead-ends)
- Same adaptation as `benchmark/datasets/long/SOURCES.md`: explicit GT + `distiller_meta`, remap `sessionId`, no invented tool transcripts.
- Synthetic `many-retries.jsonl` remains the local multi-retry fixture.
