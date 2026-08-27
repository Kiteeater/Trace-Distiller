# 流水线 + 两个 agent 洞（编排不用 LLM）

Benchmark 要求指标可复现：切多少段、先跑哪步、失败重试不能交给 LLM。因此 Trace Distiller **不是一个 agent**，而是确定性 TypeScript 流水线；仅两处嵌入 pi SDK——**洞 A 骨架 pass**、**洞 B 逐窗打标**（全局衔接检查复用洞 B 会话）。编排器自写薄 CLI，不用 LangChain/CrewAI。窗口解析失败或超 token 时降级为「保守不裁」（宁多勿漏）。

**Status**: accepted

**Supersedes**: ADR-0006

详见 [architecture.md](../architecture.md)。
