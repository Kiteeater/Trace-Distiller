# 洞 B：单槽 + 渐进披露（cut-brain 优化 v2）

## Status

accepted（2026-09-11）

**Related**:

- [ADR-0010](./0010-agent-led-cut-with-tool-mask.md)（agent 主编 + tool mask；本 ADR 锁定 cut-brain / 洞 B 的上下文分层与循环）
- [ADR-0011](./0011-hole-a-sparse-sampling-intent.md)（洞 A 多轮稀疏采样；洞 A 先于 cut-brain，不产出 keep/collapse/drop）
- [ADR-0009](./0009-agent-view-and-cut-warrant.md)（AgentView / CutWarrant；注意力分辨率与拉取式放大仍成立，洞 B 侧改单槽渐进披露）

## Context

ADR-0010 把 how-to-cut 交给 cut-brain（洞 B 角色 + 工具），并要求 tool mask：全量 payload 进 store，不进下一 turn prompt。现行实现仍偏「窗式」：多段 unresolved 同轮进 prompt、`still_unresolved` 长表回放、升层证据与决策面叠在同一注意力桶。长样上这会复现 Fake 的 `useful_exploration→keep` 假阳性（超阈 Write 被邻段噪声淹没后默认 keep）。

个人项目草稿曾用 L0–L4 分层、focus≤3–5、两次升层不定仍 keep 等方案。经用户拍板 + Context Harness 评审合并后，需要把洞 B 锁成：**单槽焦点 + 证据渐进披露 + 不确定默认 collapse_uncertain**，而不是 keep-all / 多焦点窗。

## Decision

### 四原则

1. **够上下文**：该判的段有足够结构/证据，不是全量原文。
2. **注意力清晰**：每轮决策面极窄；禁止同轮多焦点 + 多证据堆叠。
3. **业务判断**（skill 钩子后做）：准则以闭集 id 指针注入，不是散文规则墙。
4. **长段渐进披露**：极端上下文管理——全文只在 store；B 只见单张证据卡。

### 上下文分层（S0–S3；不用 L0–L4 命名，避免与流水线 L0–L4 混淆）

| 层 | 内容 | 规则 |
|----|------|------|
| **S0** | harness 状态机：intent/scenario、骨架 **counts+pointers**、预算、已决 map、defer 列表 | **永不整包 dump 进 prompt**；骨架是计数与指针，不是全量 id 墙 |
| **S1** | 单槽 focus 卡（默认 focus=1；最多 2 且仅当共享同一证据链） | 每轮唯一决策面 |
| **S2** | 一张证据卡 / 一次 disclose turn：`structure` \| `headtail` \| `error` 三选一 | 硬 token 帽；**永不**把全文给 B |
| **S3** | 当前 active 的一条准则 / skill id 指针（闭集） | 极薄；不是规则全文 |

全文只在 store。工具 execute = **ACK + card_id**；messages **永不**追加 raw tool body。

### 循环

```text
while budget:
  pick ONE focus（优先级：大段 outlier > 错误窗 > 普通）
  prompt = S1 (+ 可选 S2) (+ 可选 S3)   # 禁止同轮多 focus + disclose
  B → { decision, confidence, evidence_request }
  if need_evidence and disclose_left:
    materialize ONE evidence_card → 下一轮才可见
  else:
    commit 到 S0（已决只留 id+label）
  if 两次 disclose 后仍低置信 → collapse_uncertain
assemble / writeWarrant / span 仍确定性；B 只提案标签
```

**用户锁定**：两次 disclose 仍低置信 → **`collapse_uncertain`（不是 keep）**。`keep` 必须有正向证据（骨架命中 / 显式 key_decision 等）。

### 硬预算

- 轮数 ≤ unresolved × 2
- 每段 disclose ≤ 2
- focus = 1（例外见上）
- S2 固定 token 帽
- 禁止同轮多 focus + disclose

### 输出 schema

`decision` + `confidence` + `evidence_request(null|structure|headtail|error)`。  
禁止在 prompt 里长表回放 `still_unresolved` / gaps 历史；gaps 只进 S0 状态机，下一轮只暴露「唯一升层目标」一条。

### 预算耗尽

**禁止** fallback keep-all。剩余未决 → `collapse_uncertain` 或 `drop_by_policy`（产品二选一须在实现 PR 锁死；本 ADR 禁止 keep-all）。

### Fake / 回归板

- 抓住 `useful_exploration→keep` 假阳性；与真路径对齐同一套浅层谓词（可执行，非散文）。
- 超阈 Write **不得**默认 keep。
- Fake **不得**把「2 discloses → keep」编码成绿灯。
- Fake **禁止** L4 全文读取；最多同构 structure 卡字段。

### Eval 附加（不只 compress）

- 超阈段 keep 率
- 单槽合规率
- 证据卡违规率（非三选一 / 超帽 / 同轮多卡）

### 本 ADR 实现范围外（follow-up）

- `business_skill` 钩子稍后
- assemble / span 不变
- B 只提案标签，不碰 span / 不改写段内容

### 【分歧】采纳自 Context Harness（相对个人项目草稿的 6 项已接受变更）

1. **同轮多 focus + 同轮升层** → 改为单槽；升层/披露只在下一轮。
2. **focus 3–5** → 默认 focus=1（最多 2，且共享证据链）。
3. **gaps / still_unresolved 回灌 B** → gaps 只进 S0 状态机；prompt 不回放长表。
4. **两次升层不定 → keep** → 改为 **`collapse_uncertain`**；keep 要正向证据。
5. **Fake 把「默认 keep / 2 discloses→keep」训成绿灯** → 禁止；Fake 须抓 keep 假阳性。
6. **工具摘要当 messages 追加** → 禁止；只回灌当前槽一张证据卡（ACK + card_id；全文在 store）。

## Consequences

- 文档叙事：洞 B / cut-brain 从「窗式多段打标」改为「单槽 + 渐进披露 + collapse_uncertain」；architecture / AGENTS 指向本 ADR。
- ADR-0010 的 tool mask / agent 主编仍成立；本 ADR 细化 cut-brain 上下文契约与不确定默认。
- ADR-0009 的 AgentView 拉取式放大仍成立；洞 B 侧默认分辨率收成 S1，主动披露才见 S2。
- 与 ADR-0010「agent/tool failure → Fail-Closed Keep」的边界：会话/工具**失败**策略仍可由编排器保守处理；**预算耗尽 / 披露耗尽仍低置信** 不适用 keep-all，走本 ADR 的 `collapse_uncertain` / `drop_by_policy`。
- 实现另开 PR：本 ADR 为 docs-only 锁定；不在此改 `src/` 生产代码。
