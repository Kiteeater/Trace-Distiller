# 洞 B：单槽 + 渐进披露（cut-brain 优化 v2）

## Status

accepted（2026-09-11；Post-merge patch 2026-09-11）

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
| **S1** | 单槽 focus 卡（**v1：focus 恒为 1**） | 每轮唯一决策面；**禁止 focus=2**（「最多 2 且共享证据链」延后，不入 v1） |
| **S2** | 一张证据卡 / 一次 disclose turn：`structure` \| `headtail` \| `error` 三选一 | 硬 token 帽；**永不**把全文给 B |
| **S3** | 当前 active 的一条准则 / skill id 指针（闭集） | 极薄；不是规则全文 |

全文只在 store。工具 execute = **ACK + card_id**；messages **永不**追加 raw tool body。

### 循环

```text
while budget:
  pick ONE focus（优先级：大段 outlier > 错误窗 > 普通）
  prompt = S1 (+ 可选 S2) (+ 可选 S3)   # 禁止同轮多 focus + disclose；v1 focus 恒 1
  B → { decision, confidence, evidence_request }
  if need_evidence and disclose_left:
    materialize ONE evidence_card → 下一轮才可见
  else:
    commit 到 S0（已决只留 id+label；harness 可驳回非法 keep）
  if evidence_request 触达该段 disclose 帽仍低置信 → collapse_uncertain
assemble / writeWarrant / span 仍确定性；B 只提案标签
```

**用户锁定**：disclose 触帽仍低置信 → **`collapse_uncertain`（不是 keep）**。`keep` 必须携带闭集正向证据位（见下）；缺位时 harness **驳回**提案并落 `collapse_uncertain`。

### 低置信可测

「仍低置信」必须可单元测试，不得散文裁量。v1 约定二选一（实现 PR 锁死其一，Fake 与真路径同构）：

- **数值**：`confidence ∈ [0,1]`，**`confidence < 0.5` → 低置信**（走 collapse_uncertain 路径）；或
- **枚举**：`confidence_band ∈ {low|med|high}`，**`low` → collapse_uncertain**（`med`/`high` 才允许继续披露或提交非 uncertain 决策）。

实现须断言：低置信路径不得落到 keep。

### Keep 正向证据闭集（v1）

`keep` **必须**至少命中下列闭集之一；**禁止**开放式「等」扩位。v1 闭集（小、可测）：

| bit id | 含义 |
|--------|------|
| `skeleton_hit` | 当前 focus 段 id 落在洞 A 骨架 `skeleton_points` / 等价指针集内 |
| `key_decision_flag` | 显式关键决策标记（与既有 `key_decision` 标签语义对齐的确定性旗标） |

缺任一可用 bit、或 B 提案 keep 但 bits 未命中 → harness **拒绝**该 keep → **`collapse_uncertain`**。后续若扩集，须另开 ADR / 显式修订本表，不得实现侧私加。

### Failure vs exhaust 决策表（实现必须单测）

原则句：**ADR-0010 Keep 仅当没有可提交的合法决策**（传输/会话/编排器硬失败且无可用 B 输出）；**任何不确定 / 不合规 / 预算耗尽路径走本 ADR-0012，禁止 keep-all。**

| 情形 | 落点 | 说明 |
|------|------|------|
| 传输 / 会话 / 编排器 **硬失败**，且 **无可用 B 输出** | **Keep**（ADR-0010 Fail-Closed） | 无合法决策可提交时的 failure policy |
| 已有 B 输出，但 **schema 非法** 且重试耗尽 | **`collapse_uncertain`** | **不是** 0010 Keep |
| `evidence_request` 触达 **每段 disclose 帽** 仍低置信 | **`collapse_uncertain`** | 见「低置信可测」 |
| **轮数预算耗尽**，仍有未决 | 见下方 **预算耗尽锁** | 默认 `collapse_uncertain` |
| B 提案 **keep** 但正向证据 bits **未命中** | harness **驳回** → **`collapse_uncertain`** | B 提案可被拒绝 |
| B 提案 **合法** collapse / drop | **接受** | 在 schema + 策略闭集内 |

### 硬预算

- 轮数 ≤ unresolved × 2
- 每段 disclose ≤ 2
- **v1：focus 恒为 1**（禁止 focus=2；共享证据链双焦点延后）
- S2 固定 token 帽（见下「S2 token 帽不变量」）
- 禁止同轮多 focus + disclose

### S2 token 帽不变量

S2 证据卡必须受 **单一具名常量** 约束（例如 `S2_EVIDENCE_CARD_TOKEN_CAP`；具体名字与数值由实现 PR 填入，本 ADR 锁不变量而非散文数字）：

1. **Fake 路径与真路径共用同一常量、同一数值**（禁止双轨不同帽）。
2. 超帽 / 非三选一 / 同轮多卡计入 **证据卡违规率**，评测须 **断言** 违规率（目标趋 0；实现 PR 可给阈值）。
3. 全文永不进 B prompt；只 ACK + `card_id` + 帽内字段。

### 输出 schema

`decision` + `confidence`（或 `confidence_band`）+ `evidence_request(null|structure|headtail|error)`；keep 时另附正向证据 bit（闭集）。  
禁止在 prompt 里长表回放 `still_unresolved` / gaps 历史；gaps 只进 S0 状态机，下一轮只暴露「唯一升层目标」一条。

### 预算耗尽锁

**禁止** fallback keep-all。

- **默认**：剩余未决 **全部** → **`collapse_uncertain`**。
- **`drop_by_policy` 仅当**该段 **已匹配** 既有确定性 drop 谓词（例如 trailing `dead_end` / 规则层已有的 routine drop 等现成谓词）——**禁止**实现者发明宽松 drop。
- 未命中既有 drop 谓词的未决段，不得因「预算不够了」而 drop；一律 `collapse_uncertain`。

### Harness 驳回（override）

Harness / 状态机对 B 提案有最终校验权：

- **非法 keep**（缺正向证据 bit、低置信 keep、schema 越界等）→ 驳回并落 **`collapse_uncertain`**。
- 合法 collapse / drop → 接受。
- 硬失败且无可用 B 输出 → 仍走 ADR-0010 Keep（见决策表）。

### Fake / 回归板

- 抓住 `useful_exploration→keep` 假阳性；与真路径对齐同一套浅层谓词（可执行，非散文）。
- 超阈 Write **不得**默认 keep。
- Fake **不得**把「2 discloses → keep」编码成绿灯。
- Fake **禁止** L4 全文读取；最多同构 structure 卡字段。
- Fake 与真路径共用 **同一** S2 token 帽常量；须覆盖 Failure vs exhaust 决策表各行的单测。

### Eval 附加（不只 compress）

- 超阈段 keep 率
- 单槽合规率（v1：focus≠1 即违规）
- 证据卡违规率（非三选一 / 超帽 / 同轮多卡）；断言与 S2 常量挂钩
- 非法 keep 被 harness 驳回 → `collapse_uncertain` 的比率（回归板）

### 本 ADR 实现范围外（follow-up）

- `business_skill` 钩子稍后
- assemble / span 不变
- B 只提案标签，不碰 span / 不改写段内容
- focus=2（共享证据链）延后；v1 不实现

### 【分歧】采纳自 Context Harness（相对个人项目草稿的 6 项已接受变更）

1. **同轮多 focus + 同轮升层** → 改为单槽；升层/披露只在下一轮。
2. **focus 3–5** → **v1 focus 恒为 1**（「最多 2 且共享证据链」延后，不入 v1）。
3. **gaps / still_unresolved 回灌 B** → gaps 只进 S0 状态机；prompt 不回放长表。
4. **两次升层不定 → keep** → 改为 **`collapse_uncertain`**；keep 要闭集正向证据。
5. **Fake 把「默认 keep / 2 discloses→keep」训成绿灯** → 禁止；Fake 须抓 keep 假阳性。
6. **工具摘要当 messages 追加** → 禁止；只回灌当前槽一张证据卡（ACK + card_id；全文在 store）。

### Post-merge patch（Context Harness）（2026-09-11）

合并后评审收紧（本小节为补丁摘要；正文已同步）：

1. **Failure vs exhaust 决策表**（上表）——实现必须单测；0010 Keep **仅**硬失败且无可用 B 输出。
2. **预算耗尽锁**：默认剩余 → `collapse_uncertain`；`drop_by_policy` 仅既有确定性 drop 谓词。
3. **正向证据闭集**：`skeleton_hit` \| `key_decision_flag`；去掉开放「等」。
4. **v1 禁止 focus=2**：Decision 锁 focus 恒 1。
5. **Harness override**：非法 keep → `collapse_uncertain`。
6. **S2 token 帽**：单一具名常量，Fake=真路径同值，违规率须断言。
7. **低置信可测**：`confidence < 0.5` 或 `low|med|high` 且 `low`→collapse。

## Consequences

- 文档叙事：洞 B / cut-brain 从「窗式多段打标」改为「单槽 + 渐进披露 + collapse_uncertain」；architecture / AGENTS 指向本 ADR。
- ADR-0010 的 tool mask / agent 主编仍成立；本 ADR 细化 cut-brain 上下文契约与不确定默认。
- ADR-0009 的 AgentView 拉取式放大仍成立；洞 B 侧默认分辨率收成 S1，主动披露才见 S2。
- 与 ADR-0010「agent/tool failure → Fail-Closed Keep」的边界：**仅**传输/会话/编排器硬失败且无可用 B 输出时 Keep；**schema 非法重试耗尽 / 披露触帽仍低置信 / 预算耗尽 / 非法 keep 被驳回** 一律走本 ADR 的 `collapse_uncertain`（或既有谓词下的 `drop_by_policy`），**禁止 keep-all**。
- **骨架硬保护**（非 revert 本 ADR）：洞 A 骨架段（`in_skeleton` / `skeleton_hit` / `skeletonSegmentIds`）在 illegal keep / disclose-cap / schema-exhaust / 预算耗尽四条路径上 **不得**落 `collapse_uncertain`；harness force keep（`skeleton_protect`，`key_decision`，confidence ≥ 0.5）或带 keep bit 重试。非骨架段仍走上表 collapse_uncertain 默认。
- 实现另开 PR：本 ADR 为 docs-only 锁定；不在此改 `src/` 生产代码。
