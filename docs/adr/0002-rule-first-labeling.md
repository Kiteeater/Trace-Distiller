# 打标以规则层为主，LLM 只处理模糊段

全量 LLM 打标会把工具自身变成成本黑洞，且长 Trace 易超 context。流水线因此采用 Rule Layer 兜底（失败调用、重复读、相似报错重试等自动标记），LLM Layer 仅判定规则判不了的探索价值；超长输入用 map-reduce 逐窗，不硬塞全量。

**Status**: accepted

**Considered Options**: LLM-first 全量打标；纯规则无 LLM。前者成本与 context 风险过高；后者对「有效探索 vs 死胡同」覆盖不足，故折中为规则优先。
