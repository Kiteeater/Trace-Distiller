# 记分板改为保真分：删除压缩硬门

## Status

accepted（2026-09-23）

**Related**:

- [ADR-0005](./0005-benchmark-multiplicative-score.md)（六门乘法。公式留在已废弃的 `compositeScore` / `m1Score`，不再是 headline）
- [ADR-0014](./0014-scoreboard-defined-composite.md)（未定义渲染 `—` / JSON `null`，不硬写成 0。本 ADR 把这条用在 `fidelity` 上）
- [ADR-0015](./0015-distill-cost-roi.md)（`distill_tokens` 只计洞 A+B，不计 L4。成本比改为只观测）
- [ADR-0007](./0007-separate-brain-label-judge-budgets.md)（L4 不进蒸馏成本分母。不变）

本 ADR 只改**怎么判过、怎么打分、怎么展示**。不改洞 A/B 裁剪、骨架选取、Jev、或产出 keep/collapse/drop 的压缩实现。

## Context

ADR-0018 之前的出门线是六门一起卡：

`BENCHMARK_PASS` + `sixMetricsPassed` / `compositeScore` / `m1Score` 仍把 compress≤0.3、recall≥0.95、replay≥0.9、qa≥0.85、coherence 均分≥4 且单项≥2、cost≤0.3（short / original≤25k 软）当硬门；记分板有 compress 列；m1 = compressionScore×recall；composite = compressionScore×recall×replay，且六门都过才定义。

压缩率因此既是硬门，又是分数乘数，又占一列。过宽（多留）会被压成未定义，即使关键步都在。连贯性是洞 B 自己打的分，假后端恒为高分，没有独立信息。假 L4 的 replay=1 是确定性 heal，冒充保真。QA 只要有数字就进硬门，没有「题集是否可靠」的标记。

## Decision

1. **彻底删除 compress**：无硬门、无分数乘法、无记分板列、无 over_keep 追踪。接受过宽在召回高时仍可能绿。
2. **过宽不盯**：只靠召回等保真信号。
3. **硬门**：`key_step_recall ≥ 0.95`；QA 仅当 case set 标 `solid` 才硬门。
4. **Replay**：fake L4 / fake replay = smoke only，不进 fidelity；real（`--with-l4` + verify）才可进 fidelity。
5. **Coherence**：退出独立 fidelity（洞 B 自打分；fake 恒 5 无信息）。
6. **Cost**：主报绝对量 AB `distill_tokens`；spent/saved 比值仅观测、不硬门；L4 仍排除在成本分母外（现有约定）。
7. **Headline**：引入新字段 `fidelity`（有金标且召回门槛满足才定义）；**不要**静默重定义旧 `m1` / `composite` 公式（可废弃、并列迁移、或明确 deprecate 注释，但不得让旧名悄悄换含义）。

### fidelity

定义条件（否则 JSON `null`，记分板 `—`，**不是** 0）：

- 有独立金标，因此 `key_step_recall` 是有限数（无金标 → `null`，skipped，不算硬挂）
- 且 `key_step_recall ≥ 0.95`

定义之后的值（0–1）：

- 从 `key_step_recall` 起
- 仅当 `replay_fidelity === 'real'` 且重放分有数值时，再乘 `replay`
- 仅当 case set 标了 `qa_solid` 且 QA 分有数值时，再乘 `qa`

不得乘入：压缩率得分、fake L4 / fake replay、未跑 verify 的重放、洞 B 自打连贯性、成本比。

`real` = 本次是 `--with-l4`（不是注入的 FakeSessionBackend）**并且** workspace `verify[]` 实际跑过（过或挂都算跑过）。`--fake-l4`、默认 bench 的假后端、以及 `--with-l4` 但 manifest 没有 `verify[]`，都不进 fidelity。假重放仍可写在观测列和 notes 里，证明 smoke 通路，不证明保真。

金标缺失或召回低于 0.95 → `null`。solid QA 低于 0.85 是另一条硬门（`qa` 单元格 `fail`，计入 `n_gate_fail`），同时把该 QA 分乘进已经定义的 fidelity；它自己不把「没金标」那种空写成 0。

### QA solid

落地前**没有** case set 的 `solid` 标记。QA 只要有数值就进旧六门（`qa ≥ 0.85`）；`null`（0/0 或解析失败）是 skipped。

本 ADR 补上条件，不出新题、不改裁剪：

- 硬门仅当 `qa_solid === true`
- 标记写在旁路 `*.key-decisions.json` 的可选布尔 `qa_solid`（与金标同文件，仍不喂洞 A/B）。缺省或 `false` = 未标 solid
- 未标 solid：有分数则记分板观测（`o`），无分数则 skip；不计 fail，不进 fidelity
- 标了 solid 且有分数：`< 0.85` 为 fail；`null` 为 skip，不挡住 fidelity 的定义
- 现有数据集都没有该字段，所以现行 QA 全部是观测，不是硬门

### 硬门与观测

计入 `n_gate_fail` 的只有：

- 有金标且召回 `< 0.95`
- solid QA 有分数且 `< 0.85`
- distill / span 失败（`process_failed`，不是压缩失败）

观测、不计 fail：重放（含 fake 与 real 的数字）、未标 solid 的 QA、连贯性、spent/saved。无金标的召回是 skip，不是 fail。

### 成本

记分板主列是绝对量 `distill_tokens`（洞 A+B）。`cost` = spent/saved 仍可显示，状态是观测，不因 `> 0.3` 判 fail。short / 小样本的「cost 只报不分」不再需要：成本比根本不是门。L4 token 仍不进这个分母。质量门控 ROI 只看召回（缺召回或 `< 0.95` → gated roi null）。压缩率不再作为质量门。

### 旧名字

`compositeScore` / `m1Score` / `sixMetricsPassed` 保留 ADR-0005 公式，含 compress 门槛与 compressionScore 乘法，并标 `@deprecated`。JSON 样本仍带这两个字段，便于对照。Markdown 记分板**不**把它们当列、不当 headline。禁止把这两个名字改成 fidelity 的含义。

`BENCHMARK_PASS.compression_ratio_max`、连贯性阈值、`distill_cost_ratio_max`、`replay_min` 留在常量里，只给上述废弃函数。`qa_min` 与 `key_step_recall_min` 仍是现行硬门用的数。压缩率得分结点同样只服务废弃函数。

不新增 over_keep / 过宽计数器，记分板也没有这一列。

蒸馏报告里的 `compression_ratio`（剪后/原）仍是对产物的测量，CutProfile 的目标带也不在本 ADR 里改。那不是记分板硬门。

## Consequences

- 过宽且召回 ≥ 0.95 的样本，fidelity 可以有定义，`n_gate_fail` 不因压缩挂。
- 假 L4 的 replay=1 不再把保真分抬上去。`--fake-l4` 仍可证明 verify smoke 与废弃 composite 通路。
- 未标 solid 的 QA，答错也不拖垮出门。
- 读板先看 recall / fidelity / `gate fails`，成本看 `distill_tokens`。废弃 composite 为 `—` 不等于 fidelity 为 `—`。
- 洞 A/B、Jev、骨架选择、keep/collapse/drop 实现不因本 ADR 改行为。
