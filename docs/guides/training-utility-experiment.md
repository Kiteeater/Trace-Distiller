# 训练效用实验（ADR-0013）

| 字段 | 内容 |
|------|------|
| 状态 | **设计已锁；实验未跑**（maturity 红区 / M3+） |
| 权威 | [ADR-0013](../adr/0013-training-utility-before-cut-polish.md) |
| 过程门禁 | [ADR-0005](../adr/0005-benchmark-multiplicative-score.md)、[benchmark.md](./benchmark.md) |

本页把 ADR-0013 的 must-run 写成可执行对照。**不**在此搭 trainer、**不**把 `*-training.json` 说成已定型 SFT。

## 1. Goal

证明 Distiller **Training Cut** 在 **同等预算** 下相对对照组能帮学生模型 SFT。

| 结果 | 产品话术 |
|------|----------|
| Distiller 臂在同等 GPU-hours **赢** raw 且赢 tools-only | 可以继续谈训练侧；仍须做完 §4 才能宣称「训练基础设施」 |
| **无增益**（不赢任一只须跑的对照） | 诚实定位 = **replay / editor**（Playback Cut、人可读剪辑仍有价值）。maturity 红区保持红 |

复合分 / m1 绿只说明剪辑器过了过程门禁，**不等于**本实验通过。

## 2. Arms（同 token budget）

四条臂吃 **同一批已准入 Trace**（Admission Gate：有 Ground Truth）。差别只在保留哪些 RawTurn。

| 臂 | 保留什么 | 禁止 |
|----|----------|------|
| **raw** | 未剪 `RawTrace.turns` 全文 | 不得先按 Distiller 标签筛 |
| **distilled** | Distiller Training Cut：`assemble` 投影的 `TrainingCut.turns`（keep 原文 + collapse 一句占位） | **禁止** `--fake-l4` / `FakeSessionBackend` 产物当本臂；那是过程门禁夹具，不是要上线的 cut |
| **tools-only** | 朴素对照，**不用 Distiller 标签**：保留 (1) 第一条 `user`（任务陈述）；(2) 全部 `tool_call` / `tool_result`；(3) 紧挨在 `tool_call` 前的一条 `thought`（同一 Action Unit）。其余 `thought` / `assistant` / `user` 丢掉 | 不得调用 cut-brain / `apply_rules_hint` |
| **human-curated** | 人类独立标 keep 的 segment id（目标 = 因果路径：关键决策 + 有效探索 + 少量代表性死胡同）。记录标注人、日期、keep id 列表 | 不得先看 Distiller warrant 再改；不得用洞 B 标签当金标 |

**v0**：human-curated **可 defer**（可选臂）。缺它仍可跑方向性实验，**不得**对外说「已胜过人类剪辑」。宣称训练基础设施前四臂必须齐。

中间产物仍是 `TrainingCut`（RawTurn[]）。聊天模板 / messages 角色映射是 M2，本实验不假装已经定型。

## 3. Alignment 与主指标

对齐的是 **池级预算**，不是把每条 raw 截成 distilled 那么短。

| 项 | 口径 |
|----|------|
| Token budget `T` | 各臂训练时看到的 **原文 token 总量相同**（ingest 口径：RawTrace 原文，工具输出全文计入） |
| GPU-hours `H` | 同一 GPU 档、同一墙钟预算。Distilled 更短 → 同一 `T`/`H` 内可过更多遍或装进更多条 |
| **主指标** | **同等 GPU-hours 谁赢**：holdout 任务成功率（pass@1 / 任务成功）。赢 = Distiller 点估计优于须跑对照，且方向稳定（至少报告均值；有重复种子则报区间） |
| 禁止当主对齐 | 把每条 raw **截断到** 该条 distilled 长度再训（那是附录诊断：同长度谁信息密度高，不是 ADR-0013 主问题） |
| 次要报告 | 压缩率、关键步召回、重放成功率（过程门禁，见 §5）。另报：各臂实际 tokens seen、epochs、GPU-hours、eval 分 |

报告：一臂一行，**禁止**把不同学生、不同任务分布合成一个总分（对齐 benchmark 分档、禁止合并平均）。

## 4. Generalization

v0 可以只跑一格；宣称训练基础设施必须再跑下面两格。

| 维度 | v0 | 须补的一格 |
|------|----|------------|
| **学生模型** | 一个开源小模型（约 7B 档，固定 base + 解码） | **换家族或换体量**（例如 Qwen → Llama，或 7B → 更小一档）。同一 eval、同一 `T`/`H` |
| **任务分布** | 一档为主（优先 **long**，主价值区；原料须过 Admission Gate） | **挪一档或一场景**：例如 train=debug / eval=implement 或 refactor；或 train=short / eval=long。不得只在一条赛道讲故事 |

换学生与挪分布分开报，不要平均。

## 5. Process gates（次要）

压缩率 × 关键步召回 × 重放成功率 = **过程门禁**（剪辑有没有把因果路径剪断），**不是**训练效用。

- 公式与及格线：[ADR-0005](../adr/0005-benchmark-multiplicative-score.md)、[benchmark.md](./benchmark.md)
- 优先级：[ADR-0013](../adr/0013-training-utility-before-cut-polish.md) — 先效用，再 cut 美学
- **复合分绿 ≠ 训练效用**。门禁红了先修 admission / span / 复合分；门禁绿了仍要看 §3 主指标

本实验 **不** 用 m1 / composite / `a_eff` 判定「能训」。

## 6. Minimal runnable scale（v0）

M1 的 3–5 条 demo **不够**做 SFT 结论。v0 只求 **能证伪**「训练基础设施」，不能单凭 v0 宣称。

| 项 | v0 建议 |
|----|---------|
| 训练池 | **30–50** 条已准入 Trace；优先 long；不要只用 `examples/` 合成小样 |
| Holdout | **≥8–10** 条任务（或池子的 ~20%），与训练池无重叠 |
| 臂 | raw + distilled + tools-only；human-curated 可选 |
| 学生 / 分布 | 各 1 个（§4 的补格留到宣称前） |
| 冻结 Distiller | 实验开始后 **禁止** 改 cut-brain / profile / 洞 A·B prompt |

**如何记录冻结点**（写入实验 `manifest`，缺一项不算可复现）：

| 字段 | 怎么记 |
|------|--------|
| `distiller_sha` | `git rev-parse HEAD`（跑 distilled 臂时的仓库提交） |
| `profile_path` | CLI `--profile <p.json>` 的路径；未传则记 `src/constant/compression.ts`（`DEFAULT_CUT_PROFILE`） |
| `profile_id` | `CutProfile.id`（默认 `"default"`；分档阀门为 `bin:short` / `bin:long` / `bin:multi_dead_end`） |
| `trace_ids` | 训练池 + holdout 各一份 id 列表 |
| `arm` | `raw` \| `distilled` \| `tools_only` \| `human_curated` |

v0 若 Distiller **不赢** → 按 §1 收束到 replay/editor，不要靠 polish 压缩率把故事圆回来。

## 7. Out of scope

| 不做 | 原因 |
|------|------|
| cut-polish PR（洞 B 启发式、压缩率调参、cut 美学） | 效用证据的 **下游**（ADR-0013 §5） |
| 在本仓发明新 workspace / 假 trainer / 假数据集 | maturity 红区：不要写半截 trainer 冒充出门 |
| 本页搭完整训练 infra（聊天模板、打包 `*.sft.jsonl`、GPU launcher、训练循环） | SFT 定型属 M2；训练资源属 M3。下一包只做四臂 **导出脚手架**（§8） |
| 用 Playback Cut / HTML 报告当训练臂 | 训练臂只认 RawTurn 列 |
| 把 `*-training.json` 改名成 `*.sft.jsonl` | 中间表示 ≠ 定型 SFT |

## 8. Next eng package（四臂导出脚手架）

**已落地脚手架**（仍不是 SFT / trainer）。导出 TrainingCut 形状，不打包 `*.sft.jsonl`。

```text
node script/run-distill.ts export-utility <trace.jsonl|dir> [--out-dir benchmark/out-utility] [--arms raw,distilled,tools_only,human_curated] [--fake-l4] [--profile p.json] [--human-keep path] [--trace-ids id1,id2]
```

`bun run export:utility -- examples/add-fix.jsonl --fake-l4`。默认臂 `raw,distilled,tools_only`；无 Hole 模型时注入 Fake 防挂（过程门禁夹具，不是要上线的 distilled 臂）。`human_curated` 无 `--human-keep` 则 stub/skip，禁止静默 raw。

**输入**

| 字段 | 含义 |
|------|------|
| `trace_ids[]` | 已准入 RawTrace id（`data/raw/`） |
| `distiller_sha` | 冻结 SHA |
| `profile_path` / `profile_id` | 冻结 CutProfile |
| `arm` | `raw` \| `distilled` \| `tools_only` \| `human_curated` |
| `human_keep_ids?` | 仅 human 臂：每条 trace 的 keep segment id |

**输出**（仍是 TrainingCut 形状，**不是** SFT）

```text
<out>/manifest.json          # sha、profile_path、profile_id、arms、trace_ids、token 口径
<out>/<arm>/<trace_id>.turns.json   # RawTurn[]（与 TrainingCut.turns 同形）
<out>/<arm>/tokens.json      # 每条 + 池合计（ingest 原文 token）
```

| 约定 | 说明 |
|------|------|
| distilled | 调现有 `distill` → assembler 的 `TrainingCut.turns`；记下 `plan_ref` |
| raw | 原样写出 `RawTrace.turns` |
| tools-only | 按 §2 规则从 RawTurn 过滤；纯函数，不进洞 |
| human-curated | 按 `human_keep_ids` 抽 RawTurn（缺 id 则该臂失败，不静默 raw） |
| 失败 | 无 GT / 不可解析 → 跳过并记入 manifest，不编造 turns |

脚手架 **输出到此为止**。下游 SFT 打包、训练循环、评测 runner 另包；在那些包落地前，禁止把本输出称为训练集。
