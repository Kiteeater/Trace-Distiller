# 蒸馏成本进分母：spent/saved 与记分板 ROI

## Status

accepted（2026-09-12）

**Related**:

- [ADR-0007](./0007-separate-brain-label-judge-budgets.md)（L4 不计蒸馏成本；主比分子仍只含洞 A+B）
- [ADR-0010](./0010-agent-led-cut-with-tool-mask.md)（agent 主编；规则是可选 cheap knife / `apply_rules_hint`，不是复活 `--no-llm`）
- [ADR-0011](./0011-hole-a-sparse-sampling-intent.md) / [ADR-0012](./0012-hole-b-single-slot-progressive-disclosure.md)（洞 A 稀疏锚点、洞 B 单槽窗；昂贵模型只打硬段）
- [ADR-0013](./0013-training-utility-before-cut-polish.md)（composite/m1 是过程门禁，不是训练效用证明；多学生 / 多 epoch 才摊薄蒸馏花费）
- [ADR-0014](./0014-scoreboard-defined-composite.md)（列 + defined 均值；headline 不硬写成 0）

## Context

已有 `distillCostRatio` = `hole_a_plus_b_tokens / tokens_removed`（`tokens_removed` ≈ RawTrace `meta.total_tokens` − TrainingCut turn tokens 之和）。L4 从未进分子（ADR-0007）。这就是用户可见的 spent/saved：**蒸馏花掉的 token / 省下的 SFT token**。

ADR-0013 把 composite/m1 定性为过程门禁。蒸馏**自身**的 token 经济此前只以 cost 门槛出现，缺少 ROI 读法：洞 A 稀疏 + 洞 B 窗式打标，是在**已经成功**的 traces 上烧贵模型。单学生 / 单 epoch SFT 常常 ROI < 1；利润出现在多学生、多 epoch、或面向人的 playback 把花费摊薄之后。

## Decision

### 1. 主比 + ROI

- **主比（保留名 `distill_cost_ratio`）**：`distill_tokens / SFT_tokens_saved`
  - `distill_tokens` = `hole_a_plus_b_tokens`（仅洞 A+B；**不计 L4**）
  - `SFT_tokens_saved` ≈ `max(0, original_tokens − training_cut_tokens)`（与今日 `tokens_removed` 同口径，负值钳到 0）
- **ROI**（inverse，并列报告）：`SFT_tokens_saved / distill_tokens`，当 `distill_tokens > 0`
  - `ROI > 1` ⇔ saved > spent ⇔ `distill_cost_ratio < 1`（单次复用 token 盈利）
  - `distill_tokens === 0` → ROI = **`null` / `—`**（不把 `+Infinity` 灌进档均值）
  - saved ≤ 0 且 spent > 0 → ROI = `0`（此时 cost_ratio = `+Infinity`）
- **不是** composite / m1 的乘法门禁。呈现遵循 ADR-0014：列 + defined 均值。

### 2. 经济叙事

洞 A 稀疏 + 洞 B 窗式用贵模型处理已成功 traces。单学生 / 单 epoch 付完 A+B 固定开销后常常亏（ROI < 1）。摊薄后 ROI > 1 的路径：多学生、多 epoch、或 playback 对人的价值——效用实验见 ADR-0013，记分板呈现见 ADR-0014。

### 3. 优化方向（锁方向；本 PR 不重做流水线）

- **规则先切约 70%** 作默认 cheap knife（高 rule coverage，再付昂贵洞）。
- 洞 A：只打分层锚点（ADR-0011），不是全文贵 pass。
- 洞 B：只标规则不敢碰的段，不是全文窗贵 pass。
- 对齐 ADR-0010：agent 仍判硬案；规则是默认 cheap knife / 可选 `apply_rules_hint`，**不是**复活 `--no-llm`。

常量 `RULES_FIRST_COVERAGE_TARGET = 0.7`（`LLM_LABEL_FRACTION_HINT` 的补）只锁方向，本 PR 不改 cut 行为。

## Consequences

- 记分板 md/json 增加 `distill_tokens` / `sft_saved` / `roi`；BinTable 有 `mean_roi` / `n_defined_roi`（只对有限 defined ROI 取均值）。
- Fake / `--fake-l4` 同样填列（Fake 用量为 0 时 roi 为 `—`，列仍在）。span / distill 失败不编造经济学数字。
- 不放松 `compress ≤ 0.3` / `BENCHMARK_PASS`；ROI 失败不归零 composite/m1。
- 规则先切 ~70% 的流水线是 follow-up。
