# 分析报告

证据来自现行 ADR、[maturity](../guides/maturity.md)、[benchmark](../guides/benchmark.md) 与 [results/](./results/) 记分板。不把 Fake 板写成 mint 保真，不把过程门禁写成 SFT 结论。

---

## 1. 场景选择理由

产品只处理**已成功且带 Ground Truth** 的 coding-agent 轨迹（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）。失败分析另开边界。一条 RawTrace = 一个任务；多任务 session 歧义则拒收。

评测场景按 **难度赛道** 选，而不是按洞 A 的五字面量混成一张榜：

| 赛道 | 为何要有 | 本仓库样本 |
|------|----------|------------|
| **short**（&lt;50 步） | 基本盘；重放应接近 100%；暴露短样固定开销 | 合成 add-fix / fluff-heavy / mul-fix；独立金标 |
| **long**（200+ 步） | 主价值区；压缩率主战场 | 合成 long-debug + MIMO 公开长会话（MIT） |
| **multi_dead_end** | 试金石：规则层对死胡同弱、洞 B 要判「探索有没有价值」 | 合成 many-retries + MIMO 带多次 `is_error` 后恢复的会话 |

禁止三档合并平均（ADR-0005 / 0014）：只挑短、干净样本会得到一张好看但无用的总分榜。

洞 A 场景码是另一轴：`debug | implement | refactor | test_fix | investigate`，用来路由 `agent/skills/*.md`，查不到回退 `implement`。MIMO 适配优先 **debug / 失败工具后再恢复**，因为因果路径长、死胡同多，最能打压缩↔召回。

原料约束：

- 合成短样：可进 git、有独立金标和 mapped workspace，适合 CI。
- MIMO：真实长会话、许可证清楚（MIT）；金标粗；无仓库 map → 重放必须 skip。
- 本地私有 3–5 条成功 Claude Code session：maturity 仍红，未用合成样冒充勾完。

---

## 2. AI 应用解决方案（Distiller pipeline）

问题：成功轨迹太长——直接 SFT 又贵又脏；人读要啃几百步。目标：压短并保留从「接到任务」到「做对」的**因果路径**，同源写出 Training Cut（原文 RawTurn 列）与 Playback Cut（卡片流）（[ADR-0003](../adr/0003-dual-cut-outputs.md)）。

解法不是「一个 Distiller Agent 包办」，而是 **agent 主编 + 确定性护栏**（[ADR-0010](../adr/0010-agent-led-cut-with-tool-mask.md)）：

```text
ingest（Admission Gate）
  → segmenter / 高精规则（cheap knife，先决议并采纳）
  → 洞 A sparseIntent / skeletonPass（多轮稀疏采样；不产出 keep/drop）
  → 洞 B cut-brain（只打未决；单槽 + 渐进披露）
  → writeWarrant / assemble（span 够得着；双产物）
  ↘ L4 eval（可选 QA / replay；日常 --fake-l4）
```

要点：

- **决策权在 agent session**；工具只执行；回灌经 tool mask。
- **admission / span / warrant / I/O** 仍是 TypeScript，可复现。
- 骨架段规则禁 drop/collapse；未决 ∪ 洞 B 硬失败 → Fail-Closed Keep（仅交给 B 的 id）。
- 洞工具闭集：`label_segment` / `check_continuity` / `keep_segment` / `read_segment` / `apply_rules_hint`。没有 `edit_trace` / `drop_segment`。
- 任意 OpenAI-compatible 网关；模型档走 `TRACE_DISTILLER_MODEL_HOLE_A/B/L4`。pi 只经 `src/agent/sessions/`。
- 规则覆盖是观测 hint，不是纯规则产品路径。

评测侧：`src/eval/` 出数字；`benchmark/` 分档扫盘；`export-utility --align-budget` 把四臂 cut 交给外部 SFT。本仓不跑大模型训练循环。

---

## 3. 评估维度设计依据

> 下表与本节数字是 ADR-0018 **之前**的六门设计（compress 硬门、`m1` / `composite`）。现行 headline 是 `fidelity`：压缩率不是硬门、不是乘数、不是列。见 [ADR-0018](../adr/0018-fidelity-rubric-without-compress.md)。

压缩和保真曾经用乘法绑在一起（ADR-0005）。分档报分仍然有效。过宽不再单独盯。

| 维度 | 依据（当时） | 当时及格线 |
|------|------|--------|
| 压缩率 | MVP 硬指标；口径 = RawTrace 原文 token | ≤30%（良好 ≤15%） |
| 关键步召回 | 漏关键决策则因果链断；只对独立金标 | ≥95% |
| 重放成功率 | 最接近「剪后路径走得通」；最贵 | ≥90%；无 fixture → skip |
| QA 保真 | 重放的廉价日常替代 | ≥85%；0/0 与不可解析 → skip |
| 连贯性 | 防跳步幻觉（ADR-0004）；卡下限不只卡均值 | 均分 ≥4.0 且任一项 ≥2 |
| 处理成本比 | 工具不能是成本黑洞；分子仅洞 A+B，不计 L4 | ≤30%；short/小样只报不分 |

`m1` = 压缩率得分 × 召回：这是当时的过夜读法。`composite` 六项全过才定义；fail 渲染 `—`（ADR-0014）。这两个名字的公式后来没有改，但不再是出门线。

另两层故意**不**进乘法：

- **ROI**（ADR-0015）：单次 proxy_saved / spend_AB。1×1 常亏；摊薄后才可能 >1。质量门挂了的 ROI 无意义。
- **训练效用**（ADR-0013）：同等 GPU-hours 的四臂 SFT。过程门禁绿只说明剪辑器没剪断因果，不说明学生模型更强。**本交付不承诺此项结论**（对照 out of scope）。

防 hack：不拿 Distiller 自己的标签评召回；不把 L4 token 算进「我们很省」；不给盲测看 warrant；不跨赛道平均。

---

## 4. 评测结论

分档读，不合成总分。数字见 [results/](./results/)。

### Fake（2026-09-13 @ `9b1c2b8`）— 过程门禁夹具

| 档 | n | defined m1/composite | gate fails | mean roi | 读法 |
|----|---|----------------------|------------|----------|------|
| short | 3 | 3 / 3 | 0 | 0.33 | 独立金标召回全 1；compress 全过。fluff 压到 0.016 → 压缩率得分低（m1=32），mul-fix m1=92 |
| long | 8 | 1 / 1 | 7 | 1.16 | 唯一定义分来自合成 `sess-long-debug`（m1=94.93）。7 条 MIMO 召回挂或 compress 挂 |
| multi | 3 | 1 / 1 | 2 | 0.76 | 合成 many-retries defined；两条 MIMO 挂 |

结论：在**有独立金标 + mapped workspace** 的合成样上，剪辑器过过程门禁。MIMO 在 Fake 上压缩往往过、召回不过（粗金标 + Fake 骨架只点末次 Write/Edit 与末次 ok Bash）。short 单次 ROI&lt;1，与 ADR-0015「1×1 常亏」一致；long 因省下更多原文，mean roi 到 1.16。

### Real mint

- **2026-09-11 14:13**：真模型能改 add/mul 并通过 verify；short 全被 cost（及 add-fix compress/coherence）打成 composite=0；long-debug replay 因 JSON 解析 fail（verify 其实过了）。
- **2026-09-11 16:10 slim**：cost 软门后，fluff/mul composite defined；long-debug composite=94.83；multi=96.30。**mapped 合成样上真重放成立。** add-fix QA=1/3 仍 fail。
- **2026-09-12 04:47 long mint**：合成 long-debug compress=0.100、recall=1、replay=1、QA skip（JSON）；m1=94.97。MIMO：compress 多过、recall 多数 0、replay 全 skip、QA 半数 skip。cost 出现 198–10858（pi Usage；与 Fake 的 estimateTokens 不可比）。

总判：

1. 剪辑器在合成赛道上 **过程门禁可绿**（Fake 稳定；mint 在 mapped fixture 上可绿）。
2. 公开长会话上 **压缩可见、召回与重放未闭合**（金标粗、无 workspace）。
3. **本交付不承诺训练效用结论**；外部四臂 SFT 对照 out of scope（不是本包未完成项）。
4. **单次 ROI 不是卖点**：short 1×1 亏；要靠多学生/多 epoch 摊薄，且须质量门先过。

---

## 5. 模型 / 系统失败模式与能力边界

| 边界 | 表现 | 不是 |
|------|------|------|
| Fake ≠ mint | Fake replay 是确定性 heal；Fake QA 永远可解析 JSON | Fake composite 绿 ≠ 真模型保真 |
| 无 workspace 不重放 | MIMO replay skip | 重放失败率为 0 或 100% |
| 粗金标 | MIMO `key-decisions` 可选/短列表；召回 0 可能是金标错位 | MIMO 召回 fail = 一定剪掉了关键决策 |
| QA 结构化输出脆 | 真模型 prose / 未转义引号 / 截断 → skip 或早期 fail | QA skip = 剪辑无信息 |
| 短样固定开销 | 洞 A+B 数千 token 对 original 很小的样 → cost ≫ 0.3 | 短样 composite 未定义 = 方案破产 |
| 骨架硬保护 | 规则/collapse_uncertain 不得砍骨架 | 保护骨架 = 训练一定更强 |
| Fail-Closed Keep | 洞 B 硬失败才 Keep；预算耗尽默认 collapse_uncertain | 无洞则全 keep（该产品路径已删） |
| 盲测 | 纯代码回填骨架；L4 `blindReview` 未接通 | 「已过盲测门禁」 |
| SFT 未定型 | `*-training.json` 是 RawTurn[] | 已是可训练 jsonl |
| token 计数 | ingest 口径已定；tokenizer 与 provider 对齐未锁 | 压缩率与供应商账单逐 token 对齐 |
| 真重放环境 | 本地 mapped fixture + verify；不是 SWE-bench docker | 已在沙箱里测过真实仓库成功率 |

能力内：离线把带 GT 的 claude-code JSONL 蒸馏成双产物；规则先砍例行/相似重试；洞 A 抽 intent/skeleton；洞 B 打未决；span 拦住跳步；Fake 过夜可复现。

能力外：失败轨迹、实时干预、本仓 GPU 训练、跨赛道排行榜、把 MIMO 当闭合重放集。外部四臂 SFT 对照不在本交付试验范围（optional future）。

---

## 6. 实际评测中的典型模式

### 压缩 vs 召回

乘法设计就是为了暴露它。Fake long：`mimo-7201fdae` compress 0.109（p）但 recall 0（f）；`mimo-8c09ef71` compress 0.439（f）且 recall 0。压得越狠，粗金标越容易全灭。fluff-heavy 压到 0.016 仍召回 1（金标只有末两段），但压缩率得分掉到 m1=32——不奖励剪到接近 0%。历史无洞 smoke 上 MIMO compress 0.76–1.00：不走洞就几乎不剪长会话。

### QA JSON 脆弱

mint-short 的 long-debug：`runReplay` 碰到 `"The bug is"... is not valid JSON` → replay fail，尽管 verify 已过。long-mint 多条 QA `unparseable after retries`。流水线后来加了 near-JSON 软修复与有限重试；仍无法解析则 **skipped**，不记 0。题必须能从 playback 答；模型爱写散文是黄区成本，不是剪辑公式的 bug。

### MIMO replay skip

`manifest.json` 只覆盖合成 add-fix / mul-fix。导入会话没有对应小仓，真重放需要「可改的 cwd + verify[] + L4」。bench 把 skip 当 null，避免缺 fixture 把 composite 打成失败。要测 MIMO 重放，先补 workspace map，不要先改公式。

### ROI 是单学生 proxy，不是训练节省

`sft_saved` = 原文 token − TrainingCut token。Fake short：add-fix 只省 202、花 5225 → roi=0.04；fluff 省 4629 → 0.70。档均 0.33&lt;1。long 合成样 roi=1.50，`mimo-7201fdae` 3.75。ADR-0015：利润在 3×1 / 3×3 摊薄或 playback 对人的价值上。质量门（recall≥0.95 / compress≤0.3）挂了的高 ROI 不报。P0 `utility-report` 才写摊薄与 gated ROI。

### 规则先决议、洞 B 只打未决（ADR-0015 follow-up）

`1a8c66d`：高精规则采纳后，cut-brain 只看 unresolved。覆盖率 hint=0.7 是观测目标，不是硬门、不是回到纯规则模式。骨架 / 关键决策段规则禁砍。历史 smoke 表明：没有洞，MIMO 几乎原样留下，压缩门过不了。

### Fake vs mint 保真

同一合成任务：Fake 用确定性 heal 让 verify 绿；mint 在 slim / long-mint 上是模型真的改 `a - b` → `a + b`。cost 列更不能比：Fake 走 `estimateTokens`（缺 Usage），mint 走 pi Usage，long-debug cost 到 10858。读板必须先看标签。CI 默认 Fake；真 mint 保持 opt-in。

### 其它反复出现的形态

- **kept path shorter than 2** → coherence skip（有的 MIMO 剪完不成对）。
- **QA 0/0**（fluff 早期板）视为 skip，不是 fail。
- **add-fix QA=1/3**（slim）：重放过、问答部分错——召回严、QA 松的阈值不对称是故意的。
- 旧板 composite 印 `0.00`：ADR-0014 之后改为 `—`，以免档均被字面 0 主导。

---

## 收束

Distiller 作为 **成功轨迹的剪辑器**，在合成赛道上过程门禁成立，公开长会话上压缩可见但保真未闭合。已交付价值：剪辑器 + 过程门禁证据 + 效用导出/预算对齐脚手架。外部 SFT 对照属 ADR-0013 的 optional future path，**不是 incomplete deliverable**；本包不承诺训练效用结论。过程门禁绿 ≠ 学生模型更强。
