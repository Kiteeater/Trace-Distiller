# eval — L4 评测

对应路径：`src/eval/`。压缩率、成本比等纯统计；QA 生成可降档；重放用 pi **干净会话**跑任务；盲测 review 也在这层（ADR-0009 第 ⑤ 步）。

正式复合分与分档赛道以 [benchmark/README.md](../../benchmark/README.md) 为准。eval 出数字，report 出给人看的东西——**两层分开**。

---

## 1. 目的 / 非目标

**目的**

- 给 MVP 两硬指标：压缩率、保真度（QA 或重放或盲测 review）。
- 给成本卖点：处理成本比、规则覆盖率 / LLM 段占比。
- 给 M2 发布门禁提供同一套函数，benchmark suites 以后再搬脚本。

**非目标**

- 不在每个打标窗里做重放（architecture 明确不做）。
- 不算人类可读性盲读（M3，不进自动 benchmark）。
- 不渲染 HTML。
- 不把 L4 token 计入蒸馏成本比。
- 不做失败 Trace 评测。

---

## 2. 输入输出

```ts
interface CompressionInput {
  original_tokens: number
  cut_tokens: number
}

function compressionRatio(input: CompressionInput): number
// 剪后 / 原；目标 0.10–0.30

interface CostInput {
  hole_a_plus_b_tokens: number
  tokens_removed: number
}

function distillCostRatio(input: CostInput): number
// 剪辑消耗 ÷ 剪掉的 token

interface ReviewInput {
  intent: IntentHypothesis
  playback: PlaybackCut        // 或中间剪后表示
  skeleton: Skeleton           // 仅判分用，禁止送进 review 会话
}

interface ReviewAnswer {
  turning_point_segment_ids: string[]
  evidence_segment_ids: string[]
  free_text?: string
}

interface ReviewResult {
  passed: boolean
  missing_skeleton_nodes: string[]
  fill_in_segment_ids: string[]  // orchestrator 用来改 keep
}

function blindReview(input: ReviewInput): Promise<ReviewResult>

function generateQa(raw: RawTrace, view: AgentView): Promise<QaItem[]>
function answerQa(cut: TrainingCut | PlaybackCut, items: QaItem[]): Promise<QaScore>

function replay(task: ReplayTask, plan: CutPlan): Promise<{ success: boolean }>

function compositeScore(parts: BenchmarkParts): number
// 六项未全部及格 → 0；否则 压缩率得分 × 关键步召回 × 重放成功率
```

M1 最低：`compressionRatio` +（`blindReview` 或 `answerQa`）落地。重放和复合分可先搭函数空壳。

---

## 3. 职责与边界

**做**

- 纯统计函数：压缩率、成本比、规则覆盖率（调 data）。
- 开 L4 会话：必须 `agent/sessions` 的 `openQaSession` / `openReplaySession` / `openReviewSession`。
- 盲测判分：**确定性代码**对照骨架，不把自由文本当分数（TODO：review 必须答结构化问题）。
- 写出 `metrics` 行。

**禁止**

- import pi。
- 把 warrant 传给 review 会话。
- 在 eval 里改 CutPlan（返回 `fill_in_segment_ids`，orchestrator 改）。
- 合并三档赛道平均分（ADR-0005）。eval 若还没有赛道字段，就不要发明一个总分排行榜。

---

## 4. 依赖关系

```text
eval → types, enums, constant, domain, data
    → agent/sessions（工厂，不开洞 A/B 打标）
    ← orchestrator（回填循环）、service（eval 子命令 / distill 末步）
    ✗ pipeline/rules, assembler 的内部函数（只吃 CutPlan）
    ✗ report
    ✗ pi
```

---

## 5. 关键规则 / 算法

- **乘法复合分**（ADR-0005）：六项全及格才计总分；压缩率得分分段映射，不奖励剪到 0%。
- **连贯性卡下限**不只卡均值。
- **盲测对抗性**（ADR-0009）：review 只拿意图 + 剪后 trace。缺失骨架点 → 代码回填对应段，最多两轮。这既是门禁也是闭环修正，也是 Fail-Closed 的另一种实现。
- **关键步召回**：金标来源是人工+强模型双标（benchmark）；MVP 可用洞 A 骨架节点当弱代理，但报告必须写明「非金标」。
- 压缩率口径与 `TraceMeta.total_tokens`、段 `tokens` 同一套（P0 未定）。

成本粗账（0009，进报告首页，不是硬门禁）：500 段全量打标 ~150k+；本方案 ≈ 2k+40k+10k ≈ 1/5。eval 应能同时跑「全量 LLM 打标」对照（TODO 成本基线），数字才站得住。

---

## 6. 仍开放的设计问题

1. **token 计量口径（P0）**：工具输出全文？卡片？不定则压缩率验收无意义。
2. **盲测判分协议（P0）**：结构化问题长什么样——关键转折点选择 + 从剪后 trace 指认证据段 id。选项怎么生成、几个选项、对上骨架算 pass 的阈值，都没有。
3. **QA 题怎么从原始 Trace 自动出**：谁写生成器、要不要 LLM、题型列表（「根因是哪行」）未设计。
4. **重放环境**：SWE-bench docker？本地无沙箱？architecture 只说「pi 起干净会话跑任务」。
5. **关键步金标** MVP 从哪来：3–5 条可以手标，流程未写。
6. **Playback vs Training 用哪份做 QA/review**：0009 说剪后 trace；人读应用 Playback，模型复述也许 Training 原文更好。未拍板。

---

## 7. 实现完成标准

- [ ] 压缩率、成本比纯函数有单测，不依赖网络。
- [ ] blindReview 在 mock 会话下：传入 warrant 会被工厂拒绝或测试断言未注入。
- [ ] 回填 id 只来自骨架节点对应段，不来自模型「我觉得还该留」。
- [ ] metrics 写入 data，report 能读到同一数字。
- [ ] grep 无 pi SDK。
- [ ] 未关闭的 P0 口径不得假装「压缩率已达标」。
