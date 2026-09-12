# 训练效用先于 cut 美学优化

## Status

accepted（2026-09-12）

**Related**:

- [ADR-0010](./0010-agent-led-cut-with-tool-mask.md) / [ADR-0011](./0011-hole-a-sparse-sampling-intent.md) / [ADR-0012](./0012-hole-b-single-slot-progressive-disclosure.md)（agent cut path：主编、洞 A 稀疏采样、洞 B 单槽渐进披露。本 ADR 不改这些契约，也不把它们当成训练侧验证）
- [ADR-0005](./0005-benchmark-multiplicative-score.md)（乘法复合分；本 ADR 把它定性为过程门禁，不是训练效用证明）
- [ADR-0014](./0014-scoreboard-defined-composite.md)（过程门禁分在记分板上仅 defined 时展示；fail 不再硬写成 0）
- [成熟度一览](../guides/maturity.md)（红区已标「训练有效性对比 / 批量入口 M3+」；本 ADR 把门槛写死）

## Context

产品叙事容易把「bench 绿了」误当成「能训」：复合分（压缩率得分 × 关键步召回 × 重放成功率）过线，看起来 Distiller 已经是训练基础设施。这是错位。

ADR-0010 / 0011 / 0012 锁的是 **怎么切**（agent 主编、注意力纪律、Fail-Closed / collapse_uncertain）。那是 cut path 的工程契约，**不等于**剪后数据能让学生模型学得更好。

成熟度红区已经写明「训练有效性对比 / 批量入口」属 M3+、禁止假装完成。本 ADR 把这条门槛写死：在效用证据出现之前，不得把 cut 美学优化当成下一件该做的事，也不得用现行复合分对外宣称训练效用。

## Decision

1. **先证明蒸馏对训练有用，再优化 cut 美学。** 优先级不可颠倒。

2. 现行分数（压缩率得分 × 关键步召回 × 重放成功率）只证明「短了还能走通」——这是 **过程门禁**（剪辑有没有把因果路径剪断），**不是**训练效用证明。复合分绿了，只说明 Distiller 作为剪辑器过了门槛，不说明 Training Cut 能训出更好的学生模型。

3. 在宣称「训练基础设施」之前，**必须**跑完下列实验（must-run；缺一项不得宣称）：

   - **同 token budget 四对照**：raw SFT vs Distiller distilled SFT vs tools-only keep vs human-curated。
   - **换学生模型**；**挪动任务分布**（不得只在一条赛道、一个学生上讲故事）。
   - **主指标**：同等 GPU-hours 谁赢。压缩率 / 关键步召回 / 重放成功率仅作次要报告，不替代主指标。

4. 若 Distiller distilled 相对对照组 **无增益** → 诚实产品定位 = **replay / editor**（Playback Cut、人可读剪辑仍有价值）。**不要**假装是训练基础设施。

5. Cut-method polish（洞 B 启发式、压缩率调参、cut 美学）是效用证据的 **下游**。除非在修已经坏掉的过程门禁（admission / span / 复合分 gates），否则不要抢先 polish。

## Consequences

- 文档与对外叙事：复合分 / m1 绿 ≠ 训练效用已证；maturity 红区「训练有效性对比」在 must-run 完成前保持红。
- ADR-0010 / 0011 / 0012 仍然约束 cut path；本 ADR 约束 **下一步做什么、什么时候可以宣称训练基础设施**。
- ADR-0005 的乘法复合分继续作为过程门禁；不升格为训练效用指标。
- 无增益时产品话术收束到 replay / editor，不把 Training Cut 中间 JSON 说成已验证的 SFT 原料。
- 本 ADR 为 docs-only 锁定；不在此改 `src/`。效用实验属 M3+，见 [milestones.md](../milestones.md)。
- 实验怎么跑（臂、预算对齐、v0 规模、导出接口）：[training-utility-experiment.md](../guides/training-utility-experiment.md)。
