# Benchmark：怎么打分、怎么防 hack

| 字段 | 内容 |
|------|------|
| 版本 | v0.2 |
| 日期 | 2026-09-09 |
| 状态 | **已收口**（公式与及格线）；token 口径对齐 ingest；盲测协议已拍板（LLM review 仍待 spike） |
| 权威来源 | [benchmark/README.md](../../benchmark/README.md)、[ADR-0005](../adr/0005-benchmark-multiplicative-score.md) |

> 压缩和保真绑在一起看。单项好看不算数。设计原文在 [benchmark/README.md](../../benchmark/README.md)，本页把它写成已定验收口径。

## 目的

把「剪好了没有」从口头标准落成数字：六项指标、乘法复合分、分档赛道。同时写清 MVP 只强制哪两件、完整套怎么搭、评测自己怎么被刷。

## 读者

- 实现 `src/eval/` 的人：函数和门禁从哪来
- 跑 M1 的人：先测什么、什么可以先空着
- 以后写 `benchmark/suites/` 的人：别另起一套公式

产品语言见 [CONTEXT.md](../../CONTEXT.md) 的 Benchmark 一节。字段级契约见 [docs/modules/eval.md](../modules/eval.md)。

## 已定结论

拍板在 [ADR-0005](../adr/0005-benchmark-multiplicative-score.md) 与 benchmark README。三层结构：

```text
第一层  6 个单项（自动）
   │    全部及格才计总分，否则 0
   ▼
第二层  乘法复合分
   │    Score = 压缩率得分 × 召回 × 重放
   │    另有人类可读性盲读，不进自动流水线
   ▼
第三层  短 / 长 / 多死胡同 分档报分，禁止合并平均
```

### 六项指标（及格线已定）

| # | 指标 | 操作口径 | 及格 / 良好 | 谁算 |
|---|------|----------|-------------|------|
| 1 | **压缩率** | 剪后 token ÷ 原 token（**RawTrace 原文 token**；工具输出全文进分母；keep 段原文之和为分子。Playback 卡片不另搞一套压缩率，见 ingest） | ≤30% / ≤15% | `eval.compressionRatio`，纯统计 |
| 2 | **关键步召回率** | 金标为「关键决策」的段，剪后仍在 `CutPlan.kept` 的比例 | ≥95% / ≥98% | 对照**独立金标**，不对照洞 B 自己的标签 |
| 3 | **重放成功率** | 干净环境只按剪后路径重做任务，是否同一正确结果 | ≥90% / ≥95% | `eval.replay`，pi 干净会话 |
| 4 | **QA 保真度** | 从原始 Trace 出题，只给剪后版作答 | ≥85% / ≥92% | `eval.generateQa` + `answerQa`；日常主力 |
| 5 | **连贯性** | 相邻保留步 1–5 分：「前一步能否自然推出后一步」 | 均分 ≥4.0 **且任一项不得低于 2** / 均分 ≥4.5 | 卡下限，不只卡均值（[ADR-0004](../adr/0004-span-constraint-reachable.md)） |
| 6 | **处理成本比** | 剪辑自己花的 token ÷ 剪掉的 token | ≤30% / ≤10% | 分子**只计洞 A + 洞 B**（及重组相关调用），**不含 L4**（[ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md)） |

阈值不对称是故意的：漏关键步是结构性伤害，QA 答错几题多半是细节。初期先守及格线，「良好」等基线跑通再校准。

### 乘法复合分（防全删 / 全留）

六项全部及格才算总分，否则 **0**。

```text
Score = 压缩率得分 × 关键步召回率 × 重放成功率
```

压缩率得分**分段映射，不奖励剪到 0%**：30% → 60，15% → 90，5% → 100，中间线性插值。召回和重放用 0–1 小数（实现时固定一种写法，写进评测脚本，禁止两套量纲混用）。

乘法而不是加权平均：任一趋零，总分崩盘。全删（召回 → 0）没分；全留（压缩率得分 → 0）也没分。

人类可读性（3 个同事各 10 分钟复述，覆盖率 ≥80%）每个版本手跑一次，**不进自动 benchmark**。训练有效性对比是 M3，也不是这六项之一。

### 分档赛道（禁止合并平均）

| 赛道 | 定义 | 作用 |
|------|------|------|
| 短 trace | &lt;50 步 | 基本盘；重放应接近 100% |
| 长 trace | 200+ 步 | 主价值区；压缩率主战场 |
| 多死胡同 | 试错很多 | 试金石；专门暴露规则层弱项 |

分开报均值 ± 标准差。禁止合成一个「总分排行榜」来挑软柿子。数据集规模建议见 [datasets.md](./datasets.md)。

### 金标与成本（已定）

- **金标只标关键决策**（改变后续方向：换思路、定位根因、选定方案、确认结论）。有效探索 / 死胡同 / 例行操作不是召回金标的必标项。
- **人工 + 强模型双标**；争议仲裁后再入库。旁路文件约定见 [datasets.md](./datasets.md)：`data/raw/<trace_id>.key-decisions.json`，gitignore，**不喂洞 B**。
- **不拿 Distiller 自己的 Rule / 洞 B 标签评自己。**
- **成本只计洞 A + 洞 B**，不含 L4（QA / 重放 / review）token。

## 怎么用 / 怎么跑

代码还没写。落地后走同一条数字链路，不要在报告里另算一套。

### MVP（M1）只强制压缩率 + 保真

产品口径：[PRD.md](../../PRD.md) §5、[milestones.md](../milestones.md)——**压缩率 + 保真度**。对应本表的 **指标 1 +（指标 4 QA 或盲测 review）**。日常用 QA 或盲测；重放太贵，M1 不强制。

M1 操作清单：

1. 3–5 条已准入 Trace 跑通 `distill`（见 [datasets.md](./datasets.md)）。
2. 记压缩率。目标朝 10%–30% 靠；口径已定（RawTrace 原文 token）。计数库选型未定时数字标估算来源，不得假装 tokenizer 已与 provider 对齐。
3. 保真：优先 `eval.blindReview`（ADR-0009 第 ⑤ 步：只给意图 + 剪后 Trace，结构化作答，代码对照骨架）或跑 QA。书面记下通过 / 未通过；答不上来要标「剪过头」还是「标签错」。
4. 复合分、三档赛道、关键步金标：搭空壳即可。金标可先手标这 3–5 条（旁路 JSON）；也可用洞 A 骨架当弱代理，**报告必须写明「非金标」**。
5. 处理成本比尽量算出来——它是卖点数字，M1 不是硬门禁。最好顺手跑一次「全量 LLM 打标」对照（TODO 成本基线）。

盲测 review 是流水线闭环（最多两轮回填），也是保真门禁。它**不能替代**指标 2 的金标召回：review 过了只说明骨架点还在，不证明金标关键步都在。

### 完整套（M2 门禁，M3 加满）

```text
每条样本：
  adapters 准入 → distill → assembler 出 CutPlan
       │
       ├─ 统计：压缩率、成本比、规则覆盖率 / LLM 段占比
       ├─ 金标：关键步召回（人工 + 强模型双标；旁路 JSON）
       ├─ QA：日常
       ├─ 连贯性：相邻 keep 对
       └─ 重放：发布 / 定期校准（不要塞进每个打标窗）

按赛道聚合：均值 ± 标准差，三档分表。
六项全及格 → 复合分；否则该样本总分 0。
```

M2：六项齐全，复合分当发布门禁，短 / 长分开报。M3+：多死胡同加满；人类可读性每版本手跑；良好档按基线校准。

命令草图（入口未建，以 [script-run-distill.md](../modules/script-run-distill.md) 为准）：

```text
node script/run-distill.ts distill <trace.jsonl> [--report out.html]
node script/run-distill.ts eval <trace_id>
```

M1 可以 `distill` 顺带盲测，不必先做独立 `eval` 子命令。

建议目录（实现评测代码时再补，现在不要空建）：

```text
benchmark/
├── README.md      ← 设计原文
├── datasets/      ← 分赛道样本与金标（真实数据默认不提交）
├── suites/        ← 各指标脚本 / 配置
└── reports/       ← 跑分（均值 ± 标准差）
```

### 怎么防 hack

| 作弊姿势 | 挡住它的规则 |
|----------|----------------|
| 全删刷压缩率 | 召回 → 0，复合分 0；压缩率得分不奖励剪到 0% |
| 全留刷保真 | 压缩率得分 → 0，复合分 0 |
| 均值掩盖一次跳崖 | 连贯性卡单步下限 2 |
| 只挑短、干净的样本报一个总分 | 三档分开报，禁止合并平均 |
| 用流水线自己的标签算召回 | 召回只对**独立金标**；双标争议先仲裁 |
| 把 QA/重放/review 的 token 算进「我们很省」 | 成本比分子不含 L4（ADR-0007） |
| 在每个打标窗里跑重放把分刷高 | architecture 明确不做；重放属 L4 / 发布门禁 |
| 口径漂移（卡片 token vs 原文 token） | 与 ingest 同一套 RawTrace 原文 token；Playback 展示长度不冒充压缩率 |
| 给 review 看 CutWarrant | 工厂拒绝；盲测对抗性（ADR-0009） |

## 和 eval 模块、报告首页的关系

三层不要揉在一起：

| 层 | 干什么 | 不干什么 |
|----|--------|----------|
| **`src/eval/`** | 出数字：压缩率、成本比、QA、重放、盲测 review、复合分函数 | 不渲染 HTML；不 import pi（干净会话走 `agent/sessions` 工厂）；不改 CutPlan（只返回回填 id） |
| **`src/report/`** | 把已经算好的数字画进自包含 HTML | 不重算公式、不另定口径 |
| **`benchmark/`** | 正式套件、分档样本、发布向报告 | 不在流水线热路径里 |

报告首页要的两个卖点数字（[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)、[report.md](../modules/report.md)）：

1. **压缩率**（指标 1）——「500 步的墙 → 30 步」
2. **处理成本比** + **LLM 只看了百分之几**（指标 6 + 规则覆盖率）——「工具自己不是成本黑洞」

这两项从 SQLite 指标表 / 打标表聚合，和 eval 写入的是同一行。复合分、分档赛道**不必**塞进每份 HTML；那是 benchmark 报告的事。M1 中段允许 metrics 空缺时显示「未跑 eval」，不要阻塞出报告。

粗账（进首页，不是硬门禁）：500 段全量打标 ~150k+ token；本方案 ≈ 2k + 40k + 10k ≈ **1/5**。eval 应能跑全量 LLM 对照组，这个 1/5 才站得住。

## 边界（非目标）

- 不在打标窗里做重放或复合分。
- 不算人类可读性、不算训练有效性（M3）。
- 不评失败 Trace（进不了 Admission Gate）。
- 不把 L4 token 计入蒸馏成本。
- 不把短 / 长 / 多死胡同合成一个平均分。
- 不在 HTML 里发明另一套四舍五入口径。
- 本页不写 `src/eval/` 的函数签名——那是 [eval.md](../modules/eval.md)。

## 开放问题

公式与及格线已收口。仍影响「能不能报分」的实现细节：

1. **token 计数库选型**：口径已定（RawTrace 原文）；用哪套 tokenizer / 是否与 provider 对齐未锁（ingest 开放问题 3）。
2. **盲测判分协议（已拍板）**：review 只拿 intent + playback；结构化答卷对照骨架；缺节点由代码回填 keep；最多 2 轮。LLM 会话仍待 spike。
3. **QA 题怎么从原始 Trace 自动出**；题型列表未设计。
4. **重放环境**：SWE-bench docker，还是本地无沙箱。
5. **Playback vs Training 用哪份做 QA/review**：人读用 Playback；模型复述也许 Training 原文更好。未拍板。
6. **召回 / 重放在公式里的量纲**：0–1 还是百分数，实现时钉死一种。

## 完成标准

- [ ] M1：压缩率函数 +（盲测 review 或 QA）可在 3–5 条样本上给出书面通过 / 未通过；计数器未对齐时标明估算。
- [ ] 报告首页的压缩率、成本比、LLM 段占比与 `data` 指标行同一数字。
- [ ] 复合分：任一单项不及格 → 0；全删 / 全留夹具拿不到分（单测，不依赖网络）。
- [ ] 连贯性夹具：均分好看但有一对接头分 &lt; 2 → 该项不及格。
- [ ] 不存在跨赛道平均分 API；eval 没有赛道字段时不要发明总分榜。
- [ ] 关键步召回不读取 Distiller 自己的 LabelDecision 当金标。
- [ ] L4 用量不进处理成本比分子。
- [ ] 人类可读性、训练有效性没有被写进自动 suites。

## 相关文档

- [benchmark/README.md](../../benchmark/README.md) — 设计原文
- [ADR-0005](../adr/0005-benchmark-multiplicative-score.md) — 乘法复合分
- [ADR-0004](../adr/0004-span-constraint-reachable.md) — 够得着
- [ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md) — 预算分账
- [docs/modules/eval.md](../modules/eval.md) / [report.md](../modules/report.md)
- [datasets.md](./datasets.md) — 样本从哪来、金标怎么标
- [ingest-and-preprocess.md](./ingest-and-preprocess.md) — token 口径
