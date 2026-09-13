# 开源交付文档包

本目录把仓库已有证据收成四份可读包，**不另发明验收口径**。产品词以 [CONTEXT.md](../../CONTEXT.md) 为准；工程规则见 [AGENTS.md](../../AGENTS.md)；成熟度见 [guides/maturity.md](../guides/maturity.md)。

**本交付试验范围不含外部/大模型 SFT 训练。** 已交付为 Distiller 源码、过程门禁评测、效用导出/预算对齐脚手架与分析。不要把过程门禁（m1 / composite）写成训练效用，也不要把记分板 `roi` 写成真实 SFT 节省（[ADR-0013](../adr/0013-training-utility-before-cut-polish.md) / [ADR-0015](../adr/0015-distill-cost-roi.md)）。

蒸馏只有 **agent 路径**（[ADR-0010](../adr/0010-agent-led-cut-with-tool-mask.md)）。CI / 无密钥用 `--fake-l4`；真模型用 env + `--with-l4`。

## 四包对照

| # | 交付物 | 本目录入口 | 仓库里已经有的 |
|---|--------|------------|----------------|
| 1 | **开源项目仓库** | 根 [README.md](../../README.md) | [`.env.example`](../../.env.example)（无密钥）、[docs/guides/](../guides/)、[AGENTS.md](../../AGENTS.md)、[docs/adr/](../adr/) |
| 2 | **评测材料** | [evaluation.md](./evaluation.md) | [guides/benchmark.md](../guides/benchmark.md)、[guides/datasets.md](../guides/datasets.md)、[benchmark/datasets/](../../benchmark/datasets/)、[package.json](../../package.json) 脚本 |
| 3 | **有效性验证结果** | [validity.md](./validity.md) | [guides/maturity.md](../guides/maturity.md)、ADR-0013 P0 harness（PR #65 / `9b1c2b8`）；[training-utility-experiment.md](../guides/training-utility-experiment.md) 为范围外可选后续设计 |
| 4 | **分析报告** | [analysis-report.md](./analysis-report.md) | 记分板摘录见 [results/](./results/)、ADR-0013/0014/0015 |

完整数字表在 [results/](./results/)（从本机 gitignore 的 `benchmark/out*` 抄入，带 Fake / mint 标签）。

## 读法（先分清三件事）

1. **过程门禁**（m1 / composite）：剪辑有没有把因果路径剪断。公式见 ADR-0005 / 0014。**已交付并评测。**
2. **训练效用 / 外部 SFT**（ADR-0013 四臂对照）：同等 GPU-hours 谁赢。**本交付试验范围不含**（out of scope for this deliverable）。P0 harness（`export-utility` / `--align-budget`）已落地，可作为 optional future path，**不是未完成交付**。
3. **ROI**（ADR-0015）：`proxy_saved_trainingcut / spend_AB`，单次 token 账；不是效用证明。

## 相关

- 评测枢纽也可从 [docs/evaluation/README.md](../evaluation/README.md) 进来（指向本目录）。
- 根 README 只保留快速开始；细节不在此重复。
