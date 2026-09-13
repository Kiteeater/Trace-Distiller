# 有效性验证结果

本页只陈述**已经跑过的实验**和它们**能证明 / 不能证明**的事。成熟度色标以 [guides/maturity.md](../guides/maturity.md) 为准，不在此改口径。

## 1. 实验过程（按时间）

| 何时（本地 +08） | 跑了什么 | 标签 | 证据 |
|------------------|----------|------|------|
| 2026-09-11 14:13 | 真 mint 三档合成样（尚无 MIMO） | 黄 | [mint-short-2026-09-11.md](./results/mint-short-2026-09-11.md) |
| 2026-09-11 16:10 | 真 mint slim 子集 | 黄 | [mint-post37-slim-2026-09-11.md](./results/mint-post37-slim-2026-09-11.md) |
| 2026-09-11 17:28 | long smoke（当时无洞记分；现行不可复现） | 历史对照 | [long-smoke-2026-09-11.md](./results/long-smoke-2026-09-11.md) |
| 2026-09-12 04:47 | 真 mint long（含 MIMO）+ L4 | 黄 | [long-mint-2026-09-12.md](./results/long-mint-2026-09-12.md) |
| 2026-09-13 22:41 | Fake 全量三档 @ HEAD `9b1c2b8` | 绿 | [fake-m1-2026-09-13.md](./results/fake-m1-2026-09-13.md) |

仓库锚点：`9b1c2b8` = merge **PR #65**（ADR-0013 P0：四臂导出 + `--align-budget` 池级对齐 + 摊薄 / 质量门控 ROI）。记分板文件 gitignore，上表「何时」来自本地 mtime，不是 git blob。

单测 / typecheck 绿路径（`bun run test`、`bun run typecheck`、`bun run distill:example`）证明流水线契约，不是训练效用。

## 2. ADR-0013 P0 harness：落地了什么

已落地（PR #65 / `3ad58c8` → merge `9b1c2b8`）：

- `export-utility` 写出 `manifest.json` + `<arm>/<trace_id>.turns.json` + `tokens.json`
- `--align-budget` 后处理到 `<out>/budgeted/`（整条 trace 子采样对齐池级 `T`，禁止把单条 raw 截到 distilled 那么短）
- `handoff.json` + `utility-report.json`（摊薄 1×1 / 3×1 / 3×3、质量门控 ROI）

这证明：**可以把四臂 TrainingCut 交到外部 SFT 包，并按同等池级 token 预算对齐。** 本仓库仍不内置训练循环，不打包 `*.sft.jsonl`。

`--fake-l4` 导出的 distilled 臂是过程门禁夹具，**不是**要上线的 distilled 臂（training-utility-experiment.md §8–§9）。

## 3. 什么证明什么

### 绿：过程门禁在 Fake 上可复现

[fake-m1-2026-09-13.md](./results/fake-m1-2026-09-13.md)：

- **short** 3/3 defined m1/composite，gate fails=0。独立金标召回=1。压缩率 0.016–0.238，落在 ≤0.3。
- **合成 long / multi**（`sess-long-debug` / `sess-multi-dead`）defined composite ≈95–96，召回=1。
- 证明：在独立金标 + mapped workspace 的合成样上，agent 路径（Fake 洞 A/B + 假 L4）能同时压短并保住关键步；乘法门禁没有被全删/全留刷掉。

Fake replay 的 note 写明 *deterministic workspace heal (CI only; not mint fidelity)*。它证明 **composite 通路和 verify 闸门**，不证明真模型会改对文件。

### 黄：真 mint 接口已接，样本级不稳定

- **mapped workspace 重放可以成功**：post37-slim 与 long-mint 的 `sess-*-debug` / add-fix / mul-fix 出现「模型改了 `add.ts`/`mul.ts` 且 `verify[]` 通过」。这是真 L4 重放的正面证据。
- **短样 cost**：洞 A+B 固定开销在 short 上常 >0.3。现行 **cost 只报不分**（不拖垮 composite）；2026-09-11 14:13 板尚未按此呈现，short composite 全 0。
- **QA JSON**：long-mint 多条 `unparseable after retries` → QA skipped。后续有 near-JSON 软修复（`be95a1d`），仍不能保证真模型次次可解析。
- **MIMO 重放**：无 workspace map → skip，不是 fail=0。真重放成功率在导入样上 **未测到**。
- **MIMO 召回**：金标粗；Fake 板上多数 recall=0 或 0.33–0.5（fail）。long-mint 上少数条 recall=1（`mimo-d307bfb5`、`mimo-7201fdae`）。不能把 MIMO 召回当金标级结论。

### 红：训练效用未证

| 声称 | 实际 |
|------|------|
| 「composite / m1 绿 = 能训」 | **否**。ADR-0013：过程门禁 ≠ 训练效用 |
| 「已跑四臂 SFT」 | **否**。设计锁在 [training-utility-experiment.md](../guides/training-utility-experiment.md)；maturity **红** |
| 「`sft_saved` / `roi` = 真实训练节省」 | **否**。`sft_saved` 是 proxy_saved_trainingcut；单学生 1×1 常 ROI<1（Fake short mean roi=0.33） |
| 「Training Cut 已是 SFT 模板」 | **否**。中间 `RawTurn[]`；聊天模板 / messages 映射属 M2 红区 |
| 「已过盲测门禁」 | **否**。纯代码对照骨架已通；调 L4 `blindReview` 未接通 |
| 「私有 3–5 条真实 GT 已齐」 | **否**。公开 MIMO 已适配；本地私有成功 Trace 仍待接入 |

未跑：学生模型 SFT、holdout pass@1、换家族/换体量、挪任务分布、human-curated 对照、人类可读性盲读。

## 4. 成熟度对照（摘录）

| 色 | 能力 | 本包对应 |
|----|------|----------|
| 绿 | 离线蒸馏（`--fake-l4`）；假 L4 记分板 + m1 + `a_eff` | Fake 板；`bun run distill:example` / `bench:m1` |
| 绿 | 同源 Training / Playback 中间表示 | assembler 已写；**不是**定型 SFT |
| 黄 | 短/长样真 `with_llm`；真 mint L4 QA/replay | mint 诸板；贵、超时、JSON 脆 |
| 红 | Training Cut → SFT 导出定型 | M2 |
| 红 | 训练有效性对比 / 批量入口 | M3+；P0 只把 harness 交给外部 |
| 红 | 盲测调 L4 | 未接通 |

## 5. 结论（有效性）

1. **作为剪辑器的过程门禁**：合成样 + 独立金标上，Fake 可复现；真 mint 在 mapped fixture 上重放过线。MIMO 只能谈压缩与粗召回，不能谈重放。
2. **作为训练基础设施**：证据不足。P0 只证明「能导出并对齐预算」。在四臂 SFT 跑完之前，产品定位不得写成「已验证的 SFT 原料」；无增益时按 ADR-0013 收束为 replay/editor。
3. **ROI**：可报单次 proxy 账和摊薄情景；质量门（召回/压缩）挂了的「省 token」无意义。
