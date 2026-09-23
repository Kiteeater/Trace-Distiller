# Benchmark 用乘法复合分锁死「压缩 ↔ 保真」

压缩率和保真可以分别刷到极端（全删 / 全留），单项好看不等于方案成立。Benchmark 规定：六项全部及格才计总分，否则为 0；总分 = 压缩率得分 × 关键步召回 × 重放成功率。乘法下任一趋零则总分崩盘。压缩率得分分段映射且不奖励剪到 0%；连贯性另卡单步下限。分短 / 长 / 多死胡同三档赛道分开报分。

**Status**: accepted

记分板呈现（fail 不再硬写成字面 0；公式在 defined 时不变）见 [ADR-0014](./0014-scoreboard-defined-composite.md)。

**现行出门线已改**：[ADR-0018](./0018-fidelity-rubric-without-compress.md) 删除 compress 硬门、乘数和记分板列，headline 改为 `fidelity`。下文乘法公式只留在已废弃的 `compositeScore` / `m1Score`，名字含义不改。

详见 [benchmark/README.md](../../benchmark/README.md)。
