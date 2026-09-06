# 数据集：原料从哪来、什么能进、怎么标

> 只收「最终做对了」的 Trace。没有 Ground Truth 的、失败的，一律不进。

## 目的

写清原料来源、准入门槛、M1 要几条、文件放哪、大文件为什么不进 git、关键步金标怎么双标。这是训练数据质量的生命线，也是 benchmark 召回率的对照物。

## 读者

- 准备 M1 原料的人（先跑哪几条 session）
- 写 adapter / Admission Gate 的人（什么叫「能进」）
- 标关键步、以后建 `benchmark/datasets/` 的人

用词以 [CONTEXT.md](../../CONTEXT.md) 的「原料与准入」为准。工程解析见 [adapters.md](../modules/adapters.md)；产品边界见 [agent-gateway.md](./agent-gateway.md)。

## 已定结论

[ADR-0001](../adr/0001-ground-truth-admission-gate.md)：无 Ground Truth 一律不进流水线。失败 Trace 不分析——没有可靠对照，剪完也无法谈保真，还会把脏数据送进 SFT。

Ground Truth = 可独立验证的完成标记（测试通过 / 任务产出被确认）。不是「看起来成功」、不是「人工觉得对」。

一条 Trace = **一个任务**。Claude Code 一条 session 常含多个任务；session ≠ trace，切开是接入侧的事，策略仍 OPEN（见下）。

## 数据从哪来

| 来源 | 为什么适合 | M1 | 备注 |
|------|------------|----|------|
| **本地 Claude Code session**（JSONL） | 结构化、好切；手头就有 | **优先先用起来**（[TODO.md](../TODO.md)） | adapter 优先级最高 |
| **openclaw session** | 同是本地 agent 记录 | 若与 Claude Code 同构，可复用同一 parser | `TraceSource` 尚未单列 openclaw，先当同源或后扩 |
| **SWE-bench 成功轨迹** | 自带 resolved / 测试，正好钉死「什么叫成功」 | PRD 优先推荐；包结构本仓库还没有样例 | 只收 **resolved**；失败的不进 |
| **pi session** | 与洞内内核同格式，后期对齐方便 | 随后 | `TraceSource = 'pi-session'` |

后续扩展（未排期，不挡 M1）：更多 SWE-bench 实例、其它带可验证完成标记的 agent 记录。扩展前提不变：**自带 Ground Truth**。没有验证的公开 dump 不收。

不收：失败轨迹、进行中的 session、人工「感觉做对了」但没有任何测试/产出证据的记录。

## 门槛：必须有 Ground Truth

Admission Gate 在接入门面执行（[agent-gateway.md](./agent-gateway.md)）：

- 有 `ground_truth.kind`（`tests_passed` | `task_confirmed`）且 `evidence_ref` 能指回可核对证据 → 放行
- 否则拒绝，错误码 `no_ground_truth`，不写 `data/raw` 入库、不进 SQLite、不进洞

SWE-bench：用官方 resolved 标记当证据。Claude Code：测试命令输出、断言日志等——**具体形状仍 OPEN**，在拍板前宁可少收，不要「用户说了句好了」就放行。

data 层是第二道闸：`ground_truth_ref` 为空的 traces 插入应失败。

## M1 规模与存放

**M1 要 3–5 条**带「最终做对了」标记的 Trace（[milestones.md](../milestones.md)）。出门门槛：至少 3 条剪后版本，压缩率落在可讨论区间，保真盲测有书面结论。

### 目录约定

```text
data/raw/           准入后的原始 Trace（结构化 JSON / JSONL）
data/distilled/     剪辑产物
  *-training.*      Training Cut（SFT；M2 起严格执行）
  *-playback.*      Playback Cut（导演剪辑；同源 CutPlan，见 ADR-0003）
examples/           待建：3–5 条 demo 原料 + 跑出的 HTML 报告（讲解用）
benchmark/datasets/ 待建：分赛道样本与金标（正式套件，不是 M1 必建）
```

运行时大文件进 `data/raw` 与 `data/distilled`。`.gitignore` 已忽略这两棵树的内容，只保留 README 与 `.gitkeep`：

```text
data/raw/**
!data/raw/.gitkeep
!data/raw/README.md
data/distilled/**
!data/distilled/.gitkeep
!data/distilled/README.md
```

**真实数据默认不入库。** 不要把整段 Claude Code session 或 SWE-bench 包 commit 进来。demo 若要进 `examples/`，只放脱敏、体量可控、确认可公开的子集。`benchmark/datasets/` 落地时同样：真实样本与金标默认不提交，目录约定见 [benchmark/README.md](../../benchmark/README.md)。

M1 可先写一份中间剪后表示，不必强行拆 `*-training.*` / `*-playback.*`；M2 再分叉格式。同一次运行的两份产物必须共享同一标签与保留集。

SQLite（打标、凭证、指标）不是替代 JSONL：原文在 `data/raw`，产物在 `data/distilled`，可查询的表在 data 层单文件库。路径由 service 传入。

## 怎么用 / 怎么跑（收一条样本）

1. 拿到一条**已成功**的记录（本地 session 或 SWE-bench resolved）。
2. 确认能指出 Ground Truth 证据（测试日志、resolved 标记、可核对产出）。
3. 确认「一条任务」：疑似多任务先不要塞——adapter 应返回 `multi_task_ambiguous`，切分策略拍板前只收已经是单任务的原料。
4. 放入工作区（例如 `data/raw/<trace_id>.jsonl`）。git 不会跟踪它。
5. `distill` 跑过 Admission Gate 才算入库；无 GT 应非 0 退出且不写 distilled。
6. 产物出现在 `data/distilled/`；报告 HTML 可另给 `--report`。
7. 这 3–5 条上做压缩率 + 保真盲测（[benchmark.md](./benchmark.md)）。

完整 benchmark 规模（M2/M3，不是 M1）：每档 30–50 条，总计 100–150 条起步；短 / 长 / 多死胡同分开报。那是以后从同一套准入规则扩出来的池子。

## 标注：关键步双标

指标 2「关键步召回率」需要**独立金标**，不能拿 Distiller 自己的 Rule / 洞 B 标签来评自己。

| 项 | 约定 |
|----|------|
| 标什么 | 原始 Trace 里哪些 Segment 是 **关键决策**（改变后续方向：换思路、定位根因、选定方案、确认结论） |
| 谁标 | **人工 + 强模型** 独立双标 |
| 争议 | 仲裁后再入库；双标不一致的不要悄悄取并集刷召回 |
| 用来干什么 | 只当召回率对照。不喂给洞 B，不当 CutProfile |
| M1 | 3–5 条可以手标；流程未写成工具。也可用洞 A 骨架当弱代理，但报告必须写「非金标」 |

有效探索 / 死胡同 / 例行操作**不是**召回率金标的必标项。召回只锁「关键决策还在不在」。流水线自己的四类标签仍按规则优先 + 洞 B 打（[ADR-0002](../adr/0002-rule-first-labeling.md)），和金标是两条线。

## 边界（非目标）

- 不收失败 Trace，不做失败分析产品。
- 不在数据集里存模型权重、不把 LLM 全文 completion 当默认产物。
- 不把 `data/raw` 当 git 仓库里的「官方训练集」。
- 不在本页设计 session 切分算法、SWE-bench 包 parser——那是 adapter 的 OPEN。
- M1 不要求 100–150 条，不要求三档赛道都填满。

## 开放问题

1. **多任务 session 切分（P0）**：按 user 新指令？按 git commit？按测试套件切换？切错会污染骨架。拍板前只收单任务原料。
2. **Claude Code 里 Ground Truth 的具体形状**：测试命令输出？用户确认？只有原则。
3. **验证点定位（P0）**：GT 证据附近哪些 turn 当洞 A 硬锚点。
4. **SWE-bench 包结构**：本仓库无样例，parser 细节写不出。
5. **openclaw 是否独立 `TraceSource`**，还是复用 `claude-code`。
6. **M1 手标流程**：3–5 条的金标存在哪（旁路 JSON？不进 git 的标注目录？），尚未写。
7. **`examples/` vs `data/raw`**：demo 子集的脱敏与许可未定。

## 完成标准

- [ ] M1 实际备齐 3–5 条带 GT 的 Trace，路径在 `data/raw/`，git status 不把它们列成待提交内容。
- [ ] 无 GT 的夹具被拒绝：不写 `data/distilled`，不进 traces 表。
- [ ] 失败轨迹没有被当成「反面教材」送进流水线。
- [ ] 关键步金标（哪怕手标）与 Distiller 的 LabelDecision 分开存放；召回计算只读金标。
- [ ] `data/raw/README.md`、`data/distilled/README.md`、本页目录约定一致。
- [ ] 上列 P0 未关闭前，不宣称「数据集已就绪可发榜」。

## 相关文档

- [data/raw/README.md](../../data/raw/README.md) / [data/distilled/README.md](../../data/distilled/README.md)
- [ADR-0001](../adr/0001-ground-truth-admission-gate.md)
- [agent-gateway.md](./agent-gateway.md)
- [benchmark.md](./benchmark.md)
- [docs/modules/data.md](../modules/data.md)
