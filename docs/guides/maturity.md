# 成熟度一览（什么绿 / 黄 / 红）

> 一夜可跑通 ≠ 训练侧产品完成。本页只标现状，不发明新验收口径。指标公式仍以 [benchmark.md](./benchmark.md) / [benchmark/README.md](../../benchmark/README.md) 为准；里程碑以 [milestones.md](../milestones.md) 为准。

## 怎么用这份清单

- **绿**：本机不碰密钥也能复现；CI / 过夜默认走这条。
- **黄**：通路已接，但有真实成本、超时或环境依赖；适合短样验证，不适合默认 CI。
- **红**：契约或 TODO 已写明，**禁止假装完成**；不要写半截 trainer / 假数据集冒充出门。

快捷命令（见根 `package.json`）：

```bash
bun run distill:example   # 无洞蒸馏示例 + live dump
bun run bench:fake        # = bench:m1；--no-llm --fake-l4 分档记分板
bun run bench:m1          # 同上；看 m1_score / scoreboard 的 m1 列
```

---

## 绿（已可用）

| 能力 | 怎么跑 | 说明 |
|------|--------|------|
| **离线蒸馏（无洞）** | `bun run distill:example` 或 `node script/run-distill.ts distill … --no-llm` | 规则已决议按 CutProfile 裁；未决 Fail-Closed Keep；写出 Training/Playback 中间表示、HTML 报告、可选 live dump |
| **假 L4 记分板 + m1** | `bun run bench:fake` / `bun run bench:m1` | `bench --no-llm --fake-l4`；stdout JSON + `benchmark/out/scoreboard.md`；有 `m1` 列（压缩率得分 × 关键步召回；cost 失败不归零 m1） |
| **真 mint 重放 + 校验（接口）** | `bench --with-l4`（需本机 `.env`）+ workspace fixture | L4 会话硬超时；mapped workspace 有 `verify[]` 时门禁重放；密钥不进仓库 |

同源双投影：assembler 已从同一 CutPlan 写出 `*-training.json`（`TrainingCut`：按保留集抽出的 RawTurn 列）与 `*-playback.json`（卡片流）。这是 M1 中间表示，**不是**定型 SFT 模板。

---

## 黄（能跑，但贵 / 脆）

| 能力 | 风险 | 建议 |
|------|------|------|
| **短样 `with_llm`（真洞 A/B）** | mint token 成本；短 trace 的 `distill_cost_ratio≤0.3` 仍可能被 pi/工具固定开销顶穿 → composite=0 | 只跑 1 条短样；看 `m1_score` 判断压缩+召回；不要把过夜默认改成 `--with-l4` |
| **真 mint L4 QA / replay / review** | 会话超时、模型波动、缺 workspace 时 replay 只能测接口 | 显式 `--with-l4`；CI 继续 `--fake-l4` |
| **可选 live Unix socket** | 默认关闭；命令结束即 unlink | 日常仍用 `--live-dump` / `file://` |

---

## 红（明确未做 / M2+）

| 能力 | 状态 | 别做什么 |
|------|------|----------|
| **Training Cut → SFT 导出** | **M2**。当前只有中间 `TrainingCut`（RawTurn[]）与 `*-training.json`。聊天模板 / messages 角色映射 / 训练集打包 **未定型**（见 [milestones.md](../milestones.md)、[TODO.md](../TODO.md) M2、ADR-0003） | 不要写假 trainer、不要把中间 JSON 改名成 `*.sft.jsonl` 假装完成 |
| **真实 GT 语料池** | `examples/` 与 `benchmark/datasets/` 多为脱敏合成 / 小样；真实带 Ground Truth 的 3–5 条成功 Trace 仍待接入 | 不要把合成小样当 M1「搞原料」勾完 |
| **盲测调 L4 `blindReview`** | 纯代码对照骨架与 plan 已通；调模型的盲测会话未接通 | 不要在报告里写「已过盲测门禁」 |
| **训练有效性对比 / 批量入口** | M3+ | — |

---

## 相关入口

- 一夜路径：[README.md](../../README.md)「一夜可跑通的路径」
- 工程规则：[AGENTS.md](../../AGENTS.md)
- 分档公式：[guides/benchmark.md](./benchmark.md)
- 产物目录约定：[data/distilled/README.md](../../data/distilled/README.md)
