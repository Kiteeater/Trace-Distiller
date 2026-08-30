# Architecture Decision Records

按序号递增：`0001-slug.md`、`0002-slug.md`…

只记录难撤销、离开上下文会让人困惑、且存在真实取舍的决策。格式见项目约定：短文即可，写清「背景 + 决定 + 原因」。

| # | 决定 |
|---|------|
| 0001 | Ground Truth 准入门：无验证不进 |
| 0002 | 规则优先打标，LLM 只处理模糊段 |
| 0003 | Training Cut / Playback Cut 双产物同源 |
| 0004 | Span 约束（步与步够得着） |
| 0005 | Benchmark 乘法复合分 |
| 0006 | Agent 编排（**已被 0008 取代**） |
| 0007 | Brain / Label / Judge 预算分账 |
| 0008 | 流水线 + 两个 agent 洞，编排不用 LLM |
| 0009 | AgentView 卡片流、头尾意图推断、CutWarrant 引用式凭证、盲测 review、CLI + CutProfile |

