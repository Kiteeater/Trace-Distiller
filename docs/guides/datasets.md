# 数据集：原料从哪来、什么能进、怎么标

| 字段 | 内容 |
|------|------|
| 版本 | v0.2 |
| 日期 | 2026-09-09 |
| 状态 | **已收口**：对齐 ingest；金标旁路路径已定 |
| 权威来源 | [ADR-0001](../adr/0001-ground-truth-admission-gate.md)、[ingest-and-preprocess.md](./ingest-and-preprocess.md) |

> 只收「最终做对了」的 Trace。没有 Ground Truth 的、失败的，一律不进。

## 目的

写清原料来源、准入门槛、M1 要几条、文件放哪、大文件为什么不进 git、关键步金标怎么双标。这是训练数据质量的生命线，也是 benchmark 召回率的对照物。

前端默认（GT 形状、锚点、session ≠ trace、切段）以 [ingest-and-preprocess.md](./ingest-and-preprocess.md) 为准，本页不另起一套。

## 读者

- 准备 M1 原料的人（先跑哪几条 session）
- 写 adapter / Admission Gate 的人（什么叫「能进」）
- 标关键步、以后建 `benchmark/datasets/` 的人

用词以 [CONTEXT.md](../../CONTEXT.md) 的「原料与准入」为准。工程解析见 [adapters.md](../modules/adapters.md)；产品边界见 [agent-gateway.md](./agent-gateway.md)。

## 已定结论

[ADR-0001](../adr/0001-ground-truth-admission-gate.md)：无 Ground Truth 一律不进流水线。失败 Trace 不分析——没有可靠对照，剪完也无法谈保真，还会把脏数据送进 SFT。

Ground Truth = 可独立验证的完成标记（测试通过 / 任务产出被确认）。不是「看起来成功」、不是「人工觉得对」。ingest 已定形状：优先显式 GT 元数据；否则最后一次成功测试类工具结果（exit 0 / PASS）；**不接受**纯用户口头「好了」当唯一 GT。

一条 Trace = **一个任务**。Claude Code 一条 session 常含多个任务；**session ≠ trace**。切分默认已在 ingest 收口：按下一条「像新任务」的 user 指令轮切；置信度不够返回 `multi_task_ambiguous`，**不按 git commit 切**。

### 公开长会话（benchmark/datasets/long）

已适配 [choucsan/mimo-claude-code-traces-1k](https://huggingface.co/datasets/choucsan/mimo-claude-code-traces-1k)（MIT）：见 `benchmark/datasets/long/SOURCES.md`。HF 上的 session JSONL；本库注入显式 GT 以便 Admission Gate。无密钥。

### 来源优先级（M1）

| 来源 | M1 | 备注 |
|------|----|------|
| **本地 Claude Code session（JSONL）** | **优先** | 唯一要写的 parser：`src/adapters/claude_code.ts` |
| **openclaw session** | 同构则复用 | **不另开 `TraceSource`**；字段与 Claude Code 同构就走同一 parser，不要为品牌再写一套准入例外 |
| **SWE-bench 成功轨迹** | MVP **不写 parser** | 只收 **resolved**；类型可预留，实现不插队 |
| **pi session** | 随后 | 不是第一原料 |

后续扩展（未排期，不挡 M1）：更多带可验证完成标记的 agent 记录。扩展前提不变：**自带 Ground Truth**。没有验证的公开 dump 不收。

不收：失败轨迹、进行中的 session、人工「感觉做对了」但没有任何测试/产出证据的记录。

### 真实数据默认不进 git

运行时大文件进 `data/raw` 与 `data/distilled`。`.gitignore` 已忽略这两棵树的内容，只保留 README 与 `.gitkeep`。不要把整段 Claude Code session 或 SWE-bench 包 commit 进来。

## 门槛：必须有 Ground Truth

Admission Gate 在接入门面执行（[agent-gateway.md](./agent-gateway.md)）：

- 有 `ground_truth.kind`（`tests_passed` | `task_confirmed`）且 `evidence_ref` 能指回可核对证据 → 放行
- 否则拒绝，错误码 `no_ground_truth`，不写 `data/raw` 入库、不进 SQLite、不进洞

SWE-bench：用官方 resolved 标记当证据——原则合格，**MVP 不做 parser**。Claude Code：按 ingest 的 GT 形状，宁可少收。

data 层是第二道闸：`ground_truth_ref` 为空的 traces 插入应失败。

## M1 规模与存放

**M1 要 3–5 条**带「最终做对了」标记的 Trace（[milestones.md](../milestones.md)）。出门门槛：至少 3 条剪后版本，压缩率落在可讨论区间，保真盲测有书面结论。先求质量与 Ground Truth 硬，不求数量。

### 目录约定

```text
data/raw/<trace_id>.jsonl                      准入后的原始 Trace
data/raw/<trace_id>.key-decisions.json         关键步金标旁路（gitignore，不喂洞 B）
data/distilled/
  *-training.*                                 Training Cut（SFT；M2 起严格执行）
  *-playback.*                                 Playback Cut（导演剪辑；同源 CutPlan）
examples/                                      待建：脱敏、体量可控的 demo
benchmark/datasets/                            待建：分赛道样本（真实数据默认不提交）
```

`.gitignore` 已覆盖：

```text
data/raw/**
!data/raw/.gitkeep
!data/raw/README.md
data/distilled/**
!data/distilled/.gitkeep
!data/distilled/README.md
```

金标旁路落在 `data/raw/` 下，因此**默认不进 git**，不必再开第二条 ignore。demo 若要进 `examples/`，只放脱敏、体量可控、确认可公开的子集。

M1 可先写一份中间剪后表示，不必强行拆 `*-training.*` / `*-playback.*`；M2 再分叉格式。同一次运行的两份产物必须共享同一标签与保留集。

SQLite（打标、凭证、指标）不是替代 JSONL：原文在 `data/raw`，产物在 `data/distilled`，可查询的表在 data 层单文件库。路径由 service 传入。

## 怎么用 / 怎么跑（收一条样本）

1. 拿到一条**已成功**的 Claude Code JSONL（M1 优先格式）。
2. 确认能指出 Ground Truth 证据（显式元数据，或最后一次成功测试类工具结果）。
3. 确认「一条任务」：疑似多任务交给 adapter 按「像新任务」user 轮切；置信度不够 → `multi_task_ambiguous`，不要硬塞。
4. 放入工作区：`data/raw/<trace_id>.jsonl`。git 不会跟踪它。
5. `distill` 跑过 Admission Gate 才算入库；无 GT 应非 0 退出且不写 distilled。
6. 产物出现在 `data/distilled/`；报告 HTML 可另给 `--report`。
7. 这 3–5 条上做压缩率 + 保真盲测（[benchmark.md](./benchmark.md)）。
8. 关键步金标写到 `data/raw/<trace_id>.key-decisions.json`，与 Distiller 标签分开放。

完整 benchmark 规模（M2/M3，不是 M1）：每档 30–50 条，总计 100–150 条起步；短 / 长 / 多死胡同分开报。那是以后从同一套准入规则扩出来的池子。

openclaw：字段同构则复用 `claude_code` parser，不要新开 `TraceSource` 枚举值挡 M1。

SWE-bench：只收 resolved；本仓库无样例，**MVP 不写 parser**。

## 标注：关键步双标

指标 2「关键步召回率」需要**独立金标**，不能拿 Distiller 自己的 Rule / 洞 B 标签来评自己。

| 项 | 约定 |
|----|------|
| 标什么 | 原始 Trace 里哪些 Segment 是 **关键决策**（改变后续方向：换思路、定位根因、选定方案、确认结论） |
| 谁标 | **人工 + 强模型** 独立双标 |
| 争议 | 仲裁后再入库；双标不一致的不要悄悄取并集刷召回 |
| 放哪 | `data/raw/<trace_id>.key-decisions.json`（旁路；gitignore） |
| 用来干什么 | 只当召回率对照。**不喂给洞 B**，不当 CutProfile，不进规则层 |
| M1 | 3–5 条可以手标。也可用洞 A 骨架当弱代理，但报告必须写「非金标」 |

有效探索 / 死胡同 / 例行操作**不是**召回率金标的必标项。召回只锁「关键决策还在不在」。流水线自己的四类标签仍按规则优先 + 洞 B 打（[ADR-0002](../adr/0002-rule-first-labeling.md)），和金标是两条线。

旁路 JSON 是给人 / eval 读的，不是第二份 RawTrace。洞 B 的输入仍是未决段 + 骨架；orchestrator / sessions **禁止**读取 `.key-decisions.json`。

## 边界（非目标）

- 不收失败 Trace，不做失败分析产品。
- 不在数据集里存模型权重、不把 LLM 全文 completion 当默认产物。
- 不把 `data/raw` 当 git 仓库里的「官方训练集」。**真实数据默认不进 git。**
- 不另开 openclaw 的 `TraceSource`；不把 SWE-bench parser 插队进 M1。
- 不把金标喂给洞 B，不拿 Distiller 自己的标签评召回。
- M1 不要求 100–150 条，不要求三档赛道都填满。
- 切分启发式阈值、测试类工具白名单仍是 ingest 的实现细节，本页不另定。

## 开放问题

来源优先级、金标路径、git 策略已收口。剩下的是实现细节，不是方向：

1. **「像新任务」的置信度启发式**（ingest 开放问题 1）：不够自信时必须退回 `multi_task_ambiguous`。
2. **测试类工具白名单**（ingest 开放问题 2）。
3. **金标 JSON 字段表**：`{ "trace_id": string, "segment_ids": string[] }`。路径仍是 `data/raw/<trace_id>.key-decisions.json`；`bench` 也可读样本旁 `<stem>.key-decisions.json`。不喂洞 B。
4. **`examples/` vs `data/raw`**：demo 子集的脱敏与许可未定。
5. **SWE-bench 包结构**：本仓库无样例；MVP 不做，类型预留即可。

## 完成标准

- [ ] M1 实际备齐 3–5 条带 GT 的 Claude Code JSONL，路径在 `data/raw/`，git status 不把它们列成待提交内容。
- [ ] 无 GT 的夹具被拒绝：不写 `data/distilled`，不进 traces 表。
- [ ] 失败轨迹没有被当成「反面教材」送进流水线。
- [ ] 关键步金标（哪怕手标）落在 `data/raw/<trace_id>.key-decisions.json`，与 LabelDecision 分开；召回计算只读金标；洞 B 读不到这份文件。
- [ ] `data/raw/README.md`、`data/distilled/README.md`、本页目录约定一致。
- [ ] README / `--help` 写明：M1 先喂 claude-code JSONL；不宣称已做 SWE-bench parser；不把 openclaw 写成独立 TraceSource。
- [ ] 上列实现细节未关闭前，不宣称「数据集已就绪可发榜」。

## 相关文档

- [data/raw/README.md](../../data/raw/README.md) / [data/distilled/README.md](../../data/distilled/README.md)
- [ADR-0001](../adr/0001-ground-truth-admission-gate.md)
- [ingest-and-preprocess.md](./ingest-and-preprocess.md)
- [agent-gateway.md](./agent-gateway.md)
- [benchmark.md](./benchmark.md)
- [file-architecture.md](./file-architecture.md)
- [docs/modules/data.md](../modules/data.md)
