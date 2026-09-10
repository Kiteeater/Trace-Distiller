# data/distilled

剪辑产物输出目录。

约定：

- `*-training.json`：**Training Cut 中间表示**（`TrainingCut`：同一 CutPlan 下按保留集抽出的 RawTurn 列）。M1 可用。
- `*-playback.json`：**Playback Cut**（AgentView 卡片流 + collapse 摘要）。
- 同一次运行的两份产物共享同一标签与保留集（见 ADR-0003）。

**SFT 定型格式（聊天模板 / 训练集打包）是 M2**，见 [docs/guides/maturity.md](../../docs/guides/maturity.md) 与 [docs/milestones.md](../../docs/milestones.md)。不要把当前 `*-training.json` 当成已完成的 SFT 导出。

真实产物默认不入库。
