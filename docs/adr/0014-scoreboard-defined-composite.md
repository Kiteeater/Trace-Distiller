# 记分板：composite / m1 仅在门槛全过时定义（不再硬写成 0）

## Status

accepted（2026-09-12）

**Related**:

- [ADR-0005](./0005-benchmark-multiplicative-score.md)（乘法公式：压缩率得分 × 召回 × 重放；本 ADR 不改公式，只改「未过门槛」的呈现）
- [ADR-0013](./0013-training-utility-before-cut-polish.md)（composite / m1 是过程门禁，不是训练效用证明；硬写成 0 会把半成功伪装成全失败，并拖垮档均值）
- [ADR-0015](./0015-distill-cost-roi.md)（ROI 同样按列 + defined 均值呈现，不硬写成 0、不进 composite 乘法）

## Context

ADR-0005 / 当时实现：任一门禁 fail → `composite` /（对应门槛下的）`m1_score` 记为字面 `0`。这会误导：

1. 半成功（例如压缩过、召回挂）看起来像总分全灭。
2. 分档均值被字面 0 主导，掩盖 per-metric 列里已经可见的 compress-pass 权衡。

单项列已经展示 value + pass/fail/skip，不应被 headline 0 盖掉。

这是**呈现层**变更：不放松 `compress ≤ 0.3` / `BENCHMARK_PASS`，不改 Hole B 裁剪逻辑。

## Decision

选方案 (a)：

1. 单项列 + pass/fail/skipped **不变**。
2. 停止「一门 fail → composite/m1 = 0」作为 headline：
   - `composite` / `m1_score` **仅当该分数所需门槛全部通过且有数值时才定义**。否则 **`null` → 渲染 `—`**，不是 `0`。
   - **m1** 所需：compression 门槛过 + key_step_recall 门槛过。召回 `null`/skipped → m1 仍 `null`（压缩过也一样）；压缩挂且无召回 → 也是 `null`，不是 `0`。
   - **composite** 所需：现行六项门槛（short / 小 original 的 cost 仍 soft：只报不分）。任一项硬 fail → `null`；六项中任一项 skipped → `null`（与今天 skip 行为相同）。
   - 所需门槛全过时，乘法公式不变（ADR-0005）：
     `composite = compressionScore × recall × replay`，
     `m1 = compressionScore × recall`。
3. **聚合**（`aggregateBins` / BinTable / scoreboard.md+json）：
   - `mean_composite` / `mean_m1_score` = **仅 defined（非 null）分数的均值**。
   - BinTable 显式计数：`n_defined_composite` / `n_defined_m1`；`n_gate_fail` = 任一项 metric status 为 `fail` 的样本数（过程门禁失败；distill/span 失败计入）。
   - 每档 headline：`n=… · mean composite=… (defined=k) · mean m1=… (defined=k) · gate fails=… · mean a_eff=…`
4. `failedBenchSample`：`composite` 为 **`null`**（不是 `0`）；compression 仍 `fail`；计入 `n_gate_fail`。

## Consequences

- 记分板不再用 0 伪装「没过门槛」；读板：先看单项 pass/fail，再看 defined composite/m1 与 gate-fail 计数。
- 档均值不再被 fail→0 拖垮。
- 门槛本身（0.3 压缩、召回/重放/QA/连贯性/cost）与 cut 逻辑不变。
- JSON `scoreboard.json` 带上新的 BinTable 计数字段。
