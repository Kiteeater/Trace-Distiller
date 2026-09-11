# 洞 A：多轮稀疏采样（意图 / 场景 / 骨架）

## Status

accepted（2026-09-11）

**Related**:

- [ADR-0010](./0010-agent-led-cut-with-tool-mask.md)（agent 主编 + tool mask；洞 A 仍先于 cut-brain）
- [ADR-0009](./0009-agent-view-and-cut-warrant.md)（AgentView / 骨架 / CutWarrant；本 ADR 演进其「头尾意图推断」采样策略）

## Context

ADR-0009 把洞 A 从「全量读」收成「头 1–2 turn + 验证点附近」一次调用；现行 `skeletonPass` 也按此注入头/验证点原文 + 紧凑卡片索引。实践中固定头尾（或头+验证点）一枪有盲区：

1. 关键转折常落在中段（错误重试簇、工具失败密集区），头尾读不到。
2. 一次调用无法表达「还差什么」——要么欠采、要么为保险塞更多原文，与 tool mask / 注意力纪律冲突。
3. 洞 A 若越权产出 keep/collapse/drop，会与 cut-brain（ADR-0010）职责重叠，破坏「骨架先、裁剪后」的分界。

需要把洞 A 锁成：**在 segment 数组上的多轮稀疏采样**，只产出意图 / 场景 / 骨架关键点，不裁剪。

## Decision

洞 A（intent / scenario / skeleton）改为 **多轮稀疏采样**，不是固定头尾一次读完。用户确认的优化点一并接受：

1. **候选池（Candidate pool）**：算法自动锚点（头段、验证点附近、错误/重试簇、工具失败密集跨度等）+ **分层随机补齐**——不是纯随机，也不是用户手挑节点。
2. **循环（Loop）**：采样 → agent 判断节点 → 若上下文不够，输出 **结构化 gaps** → 下一轮按 gaps 加权再采 → 足够后只在数组上标记 **skeleton key points** → 交给 cut-brain。洞 A **不得** 发出 keep / collapse / drop。
3. **停止（Stop）**：agent 自判 `enough`；外层始终有 **硬预算**（最大轮数、最大已读 segment 数、最大 token）。自判够了可以早停；预算到了必须停。
4. **可审计输出**：结构化  
   `{ enough, intent_v0, scenario, skeleton_points[], uncertainty, gaps? }`  
   ——禁止只交自由文本。
5. **工具路径**：经 `read_segment`（或等价读段工具）拉取；结果走 **tool mask**（ADR-0010）；全量 payload 可进 store，不进下一轮 prompt。
6. **仅 benchmark 用的向量指标**（**不是**在线停机信号）：
   - 质量：embedding cosine vs 金标 intent / skeleton recall
   - 效率：已读 tokens 或 segments
   - 复合例：`quality / log(1 + tokens)`，抑制「刷质量、炸 token」的打地鼠
7. **实现顺序**（见 Consequences）：先 (a) 分层池 + 多轮 + 硬预算 + 结构化 `enough`；再 (b) 向量效率分（独立 follow-up PR）。

## Consequences

- 文档与实现叙事从「洞 A = 固定头尾一枪」改为「洞 A = 多轮稀疏采样 → 骨架关键点」；cut-brain 仍独占 how-to-cut。
- ADR-0009 的 AgentView / CutWarrant / 盲测 review **仍成立**；仅演进其洞 A 采样策略。architecture / AGENTS 对「头/验证点注入」的描述改为指向本 ADR；（a）已落地为多轮稀疏采样。
- 在线停机只认 `enough` + 硬预算；向量分只进 bench / 报告，不绑进 session loop。
- **实现顺序**：
  - [x] (a) 分层候选池 + 多轮循环 + 硬预算 + 结构化 `enough` / `gaps` / `skeleton_points`（本决策的代码落地 PR）
  - [ ] (b) benchmark 向量效率分（cosine / recall / `quality / log(1+tokens)`）——另开 PR，不阻塞 (a)
