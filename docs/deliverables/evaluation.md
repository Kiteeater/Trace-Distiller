# 评测材料

评测枢纽：样本从哪来、怎么打分、怎么跑、数字在哪。公式与及格线以 [guides/benchmark.md](../guides/benchmark.md) 为准；本页不另起一套。

| 字段 | 内容 |
|------|------|
| 权威 | [ADR-0005](../adr/0005-benchmark-multiplicative-score.md)、[ADR-0013](../adr/0013-training-utility-before-cut-polish.md)、[ADR-0014](../adr/0014-scoreboard-defined-composite.md)、[ADR-0015](../adr/0015-distill-cost-roi.md) |
| 数据集说明 | [guides/datasets.md](../guides/datasets.md)、`benchmark/datasets/*/SOURCES.md` |
| 结果表 | [results/](./results/) |

蒸馏现行唯一路径是 **agent-led**（`with_llm`）。CI 注入 `FakeSessionBackend` / `--fake-l4`；真模型 opt-in `--with-l4`。

---

## 1. 评测样本集

扫盘目录：`benchmark/datasets/{short,long,multi_dead_end}/*.jsonl`。旁路金标：同 stem 的 `*.key-decisions.json`（**不喂洞 A/B**；召回只对独立金标，见 ADR-0005）。

三档**分开报分，禁止合并平均**。

### short（合成小样，独立金标）

| 文件 | `trace_id` | 作用 | 金标 |
|------|------------|------|------|
| `add-fix.jsonl` | `claude-code:sess-no-llm` | 修 `add.ts` 使 1+1=2；含重复读 / 失败重试 | 独立；含 `intent_text` |
| `fluff-heavy.jsonl` | `claude-code:sess-short-fluff` | 同任务、噪音重试更多 | 独立；含 `intent_text` |
| `mul-fix.jsonl` | `claude-code:sess-mul-fix` | 修 `mul.ts` 使 3×3=9 | 独立 |

这三档是 M1 / CI 基本盘，**不是**私有真实语料。`examples/add-fix.jsonl` 同源脱敏演示。

### long（合成 1 条 + MIMO 公开适配）

| 文件 | 来源 |
|------|------|
| `long-debug.jsonl` | 仓库合成长 debug；独立金标；workspace 映射到 `add-fix` |
| `mimo-algo-174fc63f.jsonl` 等 7 条 | [choucsan/mimo-claude-code-traces-1k](https://huggingface.co/datasets/choucsan/mimo-claude-code-traces-1k)（**MIT**）；适配说明见 [`long/SOURCES.md`](../../benchmark/datasets/long/SOURCES.md) |

适配：补显式 `ground_truth`（`task_confirmed`）+ `distiller_meta` 以便 Admission Gate；remap `sessionId`；**不编造**工具记录。优先带失败工具/测试后再恢复的会话。MIMO 的 `*.key-decisions.json` 是 **粗标 / 可选**，召回数字要当弱对照读。

### multi_dead_end

| 文件 | 来源 |
|------|------|
| `many-retries.jsonl` | 合成多死胡同；独立金标；workspace 映射 `add-fix` |
| `mimo-debug-validate.jsonl` / `mimo-shell-health.jsonl` | 同上 MIMO 集；见 [`multi_dead_end/SOURCES.md`](../../benchmark/datasets/multi_dead_end/SOURCES.md) |

### 重放工作区

[`benchmark/workspaces/manifest.json`](../../benchmark/workspaces/manifest.json) 只映射合成样：`sess-no-llm` / `sess-short-fluff` / `sess-long-debug` / `sess-multi-dead` → `add-fix`；`sess-mul-fix` → `mul-fix`。导入 MIMO **默认无 mapped workspace** → bench 将 replay 记为 **skipped（null）**，不因缺 fixture 归零 composite（见 benchmark.md）。真重放需要 mapped fixture + `TRACE_DISTILLER_MODEL_L4` + `verify[]`。

Admission Gate（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）：无 Ground Truth / 不可解析 / 多任务歧义 → 不进评测池。失败 Trace 不分析。

---

## 2. 评估方法

三件事情不要混：

| 层 | 回答什么 | 主指标 | 现状 |
|----|----------|--------|------|
| **过程门禁** | 剪辑有没有把因果路径剪断 | 压缩率 × 关键步召回 × 重放；记分板 `m1` / `composite` | Fake 可复现；真 mint 黄区 |
| **训练效用** | 同等 GPU-hours 学生模型谁赢 | holdout 任务成功率（ADR-0013 四臂） | **未跑**（红区） |
| **ROI** | 蒸馏自身 token 账 | `sft_saved / distill_tokens`（proxy，不计 L4） | 记分板有列；摊薄在 `export-utility` |

### 过程门禁（ADR-0005 / 0014）

六项单项始终报 value + pass/fail/skip。`composite` / `m1` **仅当所需门槛全过时定义**，否则记分板 `—`（JSON `null`），**不是** 0（ADR-0014）。档均值只对 defined；另计 `n_gate_fail`。

| 分数 | 定义（门槛全过时） | 所需门槛 |
|------|-------------------|----------|
| `m1_score` | 压缩率得分 × 关键步召回 | compress + recall |
| `composite` | 压缩率得分 × 召回 × 重放 | 现行六项（**short 或 original_tokens≤25k：cost 只报不分**；仍不计 L4） |

压缩率：剪后 token ÷ 原 token（RawTrace 原文；工具输出进分母）。及格 ≤30%。压缩率得分分段映射，不奖励剪到 0%。召回对照**独立金标**，不读 LabelDecision。L4 token 不计蒸馏成本（ADR-0007 / 0015）。

Hole A `a_eff`（ADR-0011 b）仅 bench，不是在线停机，不进 m1/composite。

### 训练效用（ADR-0013）

must-run：同 token budget 的 raw / distilled / tools-only /（宣称前）human-curated；换学生；挪分布。主指标 = 同等 GPU-hours 谁赢。复合分绿 ≠ 能训。实验设计见 [training-utility-experiment.md](../guides/training-utility-experiment.md)。**四臂 SFT 未跑。**

P0 已落地的是 **导出脚手架 + 池级预算对齐**（`--align-budget`），不是训练循环。本仓库不内置大模型训练。

### ROI（ADR-0015）

- `distill_tokens` = 洞 A+B（spend_AB）；**不计 L4**
- `sft_saved` = **proxy_saved_trainingcut** = `max(0, original − TrainingCut tokens)`，不是真实训练节省
- `roi` = saved/spent（spent=0 → `—`）；列 + defined 均值；**不是** composite/m1 门禁
- 摊薄 1×1 / 3×1 / 3×3 与质量门控 ROI 写在 `export-utility` 的 `utility-report.json`，本板无摊薄列
- 规则覆盖是分档观测 hint（`RULES_SAFE_COVERAGE_HINT=0.7`），不是硬门禁

---

## 3. 评测脚本

依赖 **bun install**；跑产物用 **node**（不要用 bun 当运行时）。密钥只放本机 `.env`（见 [`.env.example`](../../.env.example)），不进 git、不进本文。

| 脚本 | 命令 | 含义 |
|------|------|------|
| `bench:m1` / `bench:fake` | `node script/run-distill.ts bench --fake-l4` | 假 L4 分档记分板 → `benchmark/out/`（gitignore） |
| `bench:long` | `bench --fake-l4 --bin long --out-dir benchmark/out-long` | 仅 long 档假 L4（阀门 CutProfile） |
| `bench:long:mint` | `script/bench-long-mint.ts` | 真 mint long-only；默认 `SESSION_TIMEOUT_MS=300000`；`--with-l4` |
| `export:utility` | `node script/run-distill.ts export-utility …` | ADR-0013 四臂 TrainingCut 脚手架 |
| `distill:example` | 蒸馏 `examples/add-fix.jsonl --fake-l4` | 过夜绿路径演示 |

常用 flags：

```text
# 假后端（CI / 无密钥）
bun run bench:m1
# 等价：node script/run-distill.ts bench --fake-l4 [--dir benchmark/datasets] [--out-dir benchmark/out]

# 真 mint（opt-in；需 .env 的 MODEL_* / API_*）
node script/run-distill.ts bench --with-l4 [--bin short|long|multi_dead_end]
bun run bench:long:mint
# 单条 long：TRACE_DISTILLER_BENCH_LONG_SAMPLE=mimo-debug-parse.jsonl bun run bench:long:mint

# 四臂导出 + 池级预算对齐（P0 harness；不是 SFT）
bun run export:utility -- examples/add-fix.jsonl --fake-l4 --align-budget [--budget N]
# 默认臂 raw,distilled,tools_only；human_curated 无 --human-keep 则 stub/skip，禁止静默 raw
```

`--bin` / `--bins` 选赛道并用该档 CutProfile 阀门（short 少剪；long / multi 更积极 collapse + keep 地板）。无 `--with-l4` 时 bench 默认注入 Fake 防挂。`--no-vector-efficiency` 可关 Hole A `a_eff`。

---

## 4. 完整结果表格

记分板运行产物在 `benchmark/out*`（gitignore，**从未入库**）。本包把表抄进 [results/](./results/)，每份带 provenance（Fake vs mint、日期 +08、HEAD/邻近 SHA、命令）。

| 归档 | 标签 | 何时 | 命令（当时） |
|------|------|------|----------------|
| [fake-m1-2026-09-13.md](./results/fake-m1-2026-09-13.md) | **Fake** | 2026-09-13 22:41 +08 @ HEAD `9b1c2b8` | `bench --fake-l4` / `bun run bench:m1` |
| [mint-short-2026-09-11.md](./results/mint-short-2026-09-11.md) | **real mint** | 2026-09-11 14:13 +08 | `bench --with-l4`（short+合成 long/multi；尚无 MIMO） |
| [mint-post37-slim-2026-09-11.md](./results/mint-post37-slim-2026-09-11.md) | **real mint** | 2026-09-11 16:10 +08 | slim 子集真 mint；mapped workspace 重放已通 |
| [long-mint-2026-09-12.md](./results/long-mint-2026-09-12.md) | **real mint** | 2026-09-12 04:47 +08 | long mint + L4（含 MIMO） |
| [long-smoke-2026-09-11.md](./results/long-smoke-2026-09-11.md) | 历史对照 | 2026-09-11 17:28 +08 | 当时记分为 `no_llm`；**现行不是可用路径** |

读板约定：

- 先看单项 pass/fail/skip，再看 defined composite/m1 与 `gate fails`。
- 2026-09-11 板在 ADR-0014 落地前，fail 样本 headline 仍可能写成 `0.00`；现行渲染为 `—`。
- Fake 的 replay=1 带 note「deterministic workspace heal (CI only; not mint fidelity)」。
- MIMO replay skip ≠ fail=0。
- 无金标则召回 skipped，不假装测到。

有效性解读见 [validity.md](./validity.md)；模式与边界见 [analysis-report.md](./analysis-report.md)。
