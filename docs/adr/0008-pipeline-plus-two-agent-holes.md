# 流水线 + 两个 agent 洞（编排不用 LLM）

Benchmark 要求指标可复现：切多少段、先跑哪步、失败重试不能交给 LLM。因此 Trace Distiller **曾**定为确定性 TypeScript 流水线；仅两处嵌入 pi SDK——**洞 A 骨架 pass**、**洞 B 逐窗打标**（全局衔接检查复用洞 B 会话）。编排器自写薄 CLI，不用 LangChain/CrewAI。窗口解析失败或超 token 时降级为「保守不裁」（宁多勿漏）。

**Status**: **Superseded by [ADR-0010](./0010-agent-led-cut-with-tool-mask.md)**

**Supersedes**: ADR-0006

本 ADR 的「不是一个 agent / `--no-llm` 纯规则路径 / 编排永远无 LLM」已被 0010 取代：agent session 任 editor-in-chief 决定 how to cut；确定性 TS 保留 admission / span / warrant assemble / I/O；工具结果经 tool mask 回灌。洞 A/B 与 pi 仅经 `src/agent/sessions/` 的边界在 0010 下仍然成立。

详见 [architecture.md](../architecture.md) 与 ADR-0010。
