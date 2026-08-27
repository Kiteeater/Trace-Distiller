# 骨架 / 打标 / 评测三类会话分预算

编排层无 LLM，不再设「Brain 编排模型」。成本分账落在三类 pi 会话上：**骨架 pass（洞 A）**、**逐窗打标与衔接检查（洞 B）**、**评测侧 QA/重放（L4）**。混用同一配额会导致「骨架吃光预算导致打标退化」或「评测烧费算进蒸馏成本」等不可解释数字。处理成本比只计入洞 A+B（及重组相关调用），不含发布向重放。正式分数仍以外置 benchmark 为准。

**Status**: accepted

**Note**: 取代早期「Brain / Label / Judge 三端口在单一 Agent Runtime 内」的表述；分账原则不变，附着点改为两洞 + L4。

详见 [architecture.md](../architecture.md)。
