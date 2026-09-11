# 编排自主、阶段实现死

**Status**: superseded by [ADR-0008](./0008-pipeline-plus-two-agent-holes.md)

曾假设 Distiller 是「自主 Agent 运行时」且编排权在 Agent。后纠正为：编排必须是纯代码流水线以保证 benchmark 可复现；LLM 仅出现在骨架 pass 与逐窗打标两个 agent 洞。本 ADR 不再作为现行决策。

**Note**: ADR-0010 再次确认 agent 拥有裁剪决策权，但 pi / cut-brain 仍只落在 `src/agent/sessions/`，不是本 ADR 曾设想的「自主 Agent 运行时」框架。
