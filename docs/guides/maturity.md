# 成熟度一览（什么绿 / 黄 / 红）

> 一夜可跑通 ≠ 训练侧产品完成。本页只标现状，不发明新验收口径。指标公式仍以 [benchmark.md](./benchmark.md) / [benchmark/README.md](../../benchmark/README.md) 为准；里程碑以 [milestones.md](../milestones.md) 为准。

## 怎么用这份清单

- **绿**：本机不碰密钥也能复现；CI / 过夜默认走这条。
- **黄**：通路已接，但有真实成本、超时或环境依赖；适合短样验证，不适合默认 CI。
- **红**：契约或 TODO 已写明，**禁止假装完成**；不要写半截 trainer / 假数据集冒充出门。

快捷命令（见根 `package.json`）：

```bash
bun run distill:example   # agent 路径（--fake-l4）示例 + live dump
bun run bench:fake        # = bench:m1；--fake-l4 分档记分板
bun run bench:m1          # 同上；看 m1_score / scoreboard 的 m1 列
bun run bench:long        # 仅 long 档假 L4（阀门 CutProfile）
bun run bench:long:mint   # 真 mint long-only；默认 SESSION_TIMEOUT_MS=300000
```

---

## 绿（已可用）

| 能力 | 怎么跑 | 说明 |
|------|--------|------|
| **离线蒸馏（假后端 agent 路径）** | `bun run distill:example` 或 `node script/run-distill.ts distill … --fake-l4` | ADR-0010 Phase 2：无 `--no-llm`；FakeSessionBackend 走洞 A + cut-brain（可选 `apply_rules_hint`）；写出 Training/Playback、HTML 报告、可选 live dump |
| **假 L4 记分板 + m1** | `bun run bench:fake` / `bun run bench:m1` | `bench --fake-l4`；stdout JSON + `benchmark/out/scoreboard.md`；有 `m1` 列（压缩率得分 × 关键步召回；cost 失败不归零 m1） |
| **真 mint 重放 + 校验（接口）** | `bench --with-l4`（需本机 `.env`）+ workspace fixture | L4 会话硬超时；mapped workspace 有 `verify[]` 时门禁重放；密钥不进仓库 |

同源双投影：assembler 已从同一 CutPlan 写出 `*-training.json`（`TrainingCut`：按保留集抽出的 RawTurn 列）与 `*-playback.json`（卡片流）。这是 M1 中间表示，**不是**定型 SFT 模板。

---

## 黄（能跑，但贵 / 脆）

| 能力 | 风险 | 建议 |
|------|------|------|
| **短样 `with_llm`（真洞 A/B）** | mint token 成本；洞 A+B ~6–10k 固定开销会顶穿 0.3 | **short / original_tokens≤25k：cost 只报不分**（仍不计 L4）；短档阀门更少剪（`bin:short`）；看 `m1_score` + 软 cost 后的 composite；不要把过夜默认改成 `--with-l4` |
| **长样 `with_llm` / long mint** | 慢、易超时；洞窗更积极 + 更强 dead_end collapse | `--bin long` 单独跑；`SESSION_TIMEOUT_MS≥300000`；keep 地板 ~8–15%；可用 `TRACE_DISTILLER_BENCH_LONG_SAMPLE` 只 mint 一条 |
| **真 mint L4 QA / replay / review** | 会话超时、模型波动；无 mapped workspace 的导入样 replay 为 skipped；QA 曾现畸形 JSON / `correct=1/3` | 显式 `--with-l4`；长样用 `--bin long` + `TRACE_DISTILLER_SESSION_TIMEOUT_MS=300000`（或 `bun run bench:long:mint`）；CI 继续 `--fake-l4`；**QA near-JSON 软修复 + 畸形最多再试 2 次、低分再试 1 次**；无合法 pairs → skipped；题必须可从 playback 答；真 replay 需 `manifest` 映射 fixture |
| **可选 live Unix socket** | 默认关闭；命令结束即 unlink | 日常仍用 `--live-dump` / `file://` |

---

## 红（明确未做 / M2+）

| 能力 | 状态 | 别做什么 |
|------|------|----------|
| **Training Cut → SFT 导出** | **M2**。当前只有中间 `TrainingCut`（RawTurn[]）与 `*-training.json`。聊天模板 / messages 角色映射 / 训练集打包 **未定型**（见 [milestones.md](../milestones.md)、[TODO.md](../TODO.md) M2、ADR-0003） | 不要写假 trainer、不要把中间 JSON 改名成 `*.sft.jsonl` 假装完成 |
| **真实 GT 语料池** | `benchmark/datasets/long/` + `multi_dead_end/` 已接入更多 MIMO 长会话（含失败工具/重试后恢复）；本地私有 3–5 条成功 Trace 仍待接入 | 不要把合成小样当私有原料勾完；公开适配样见 `long/SOURCES.md` / `multi_dead_end/SOURCES.md` |
| **盲测调 L4 `blindReview`** | 纯代码对照骨架与 plan 已通；调模型的盲测会话未接通 | 不要在报告里写「已过盲测门禁」 |
| **训练有效性对比 / 批量入口** | M3+ | — |

---

## 相关入口

- 一夜路径：[README.md](../../README.md)「一夜可跑通的路径」
- 工程规则：[AGENTS.md](../../AGENTS.md)
- 分档公式：[guides/benchmark.md](./benchmark.md)
- 产物目录约定：[data/distilled/README.md](../../data/distilled/README.md)
