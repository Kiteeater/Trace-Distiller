# data/raw

准入后的原始 Trace 存放处（结构化 JSON）。

- 仅接受带 Ground Truth 的成功 Trace（见 ADR-0001）
- 预期来源：SWE-bench 任务记录、本地 Claude Code / openclaw session
- 真实数据默认不入库；本目录内容被 `.gitignore` 忽略（保留本说明与 `.gitkeep`）
