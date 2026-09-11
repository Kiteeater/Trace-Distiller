# Architecture Decision Records

按序号递增：`0001-slug.md`、`0002-slug.md`…

只记录难撤销、离开上下文会让人困惑、且存在真实取舍的决策。格式见项目约定：短文即可，写清「背景 + 决定 + 原因」。

| # | 决定 |
|---|------|
| 0001 | Ground Truth 准入门：无验证不进 |
| 0002 | 规则优先打标（**受 0010 影响**：规则变为可选工具/提示，不再有纯规则独立模式） |
| 0003 | Training Cut / Playback Cut 双产物同源 |
| 0004 | Span 约束（步与步够得着） |
| 0005 | Benchmark 乘法复合分 |
| 0006 | Agent 编排（**已被 0008 取代**；决策权见 0010） |
| 0007 | Brain / Label / Judge 预算分账 |
| 0008 | 流水线 + 两个 agent 洞（**已被 0010 取代**） |
| 0009 | AgentView 卡片流、头尾意图推断（**洞 A 采样见 0011**）、CutWarrant 引用式凭证、盲测 review、CLI + CutProfile |
| 0010 | **Agent 主编裁剪 + Tool Mask**（现行：删除 `--no-llm`；agent 决定 how to cut；工具只执行；结果掩码回灌） |
| 0011 | **洞 A 多轮稀疏采样**（意图/场景/骨架；分层锚点池 + gaps 加权；不产出 keep/collapse/drop；硬预算 + 结构化 enough；向量分仅 bench） |
| 0012 | **洞 B 单槽 + 渐进披露**（cut-brain 优化 v2；S0–S3；v1 focus 恒 1；disclose 触帽/低置信 → collapse_uncertain；0010 Keep 仅硬失败无 B 输出；预算耗尽默认 collapse_uncertain；Fake 禁默认 keep） |
