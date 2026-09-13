# Real mint slim 记分板（2026-09-11 16:10）

| 字段 | 内容 |
|------|------|
| 标签 | **real mint**（`--with-l4`） |
| 本地 mtime | 2026-09-11 16:10:44 +08 |
| 仓库 | 记分板 **未入库**。邻近 `c656c49`（2026-09-11 15:21，`fix: mint score root causes + long MIMO dataset`） |
| 命令 | 当时对 slim 子集跑真 mint（数据集路径 `/tmp/td-datasets-post37-slim`，不是仓库全量 `benchmark/datasets`） |
| 源 | `benchmark/out-mint-post37-slim/scoreboard.md`（`mode=with_llm`，`fake_l4=false`） |

这是 mapped workspace 上 **真模型重放已改文件并通过 verify** 的较早证据。样本仍是合成 short/long-debug/multi-dead，不含 MIMO。呈现早于 ADR-0014（部分行 composite 印 `0.00`）。cost 在 short 上已按「只报不分」处理（status pass）。

---

# Trace-Distiller Benchmark Scoreboard

- datasets: `/tmp/td-datasets-post37-slim`
- distill mode: `with_llm`
- L4 qa/replay/coherence: attempted

Tracks are scored separately and **never averaged**.

> **M1 vs composite:** `m1_score` = 压缩率得分 × 关键步召回（M1 硬门禁）。`composite` 六项门槛中，**short 档或 original_tokens≤25k 的 cost 只报不分**（洞 A+B 固定开销会顶穿 0.3；仍不计 L4）。QA 0/0 视为 skipped。compress+recall 过时看 `m1_score`。

## short

n=3 · mean composite=41.41 · mean m1=62.37

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-no-llm | 0.286 (p) | 1.000 (p) | 1.000 (p) | 0.333 (f) | 4.500 (p) | 35.948 (p) | 0.00 | 62.86 | independent |
| claude-code:sess-short-fluff | 0.015 (p) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 5.000 (p) | 2.091 (p) | 30.44 | 30.44 | independent |
| claude-code:sess-mul-fix | 0.047 (p) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 4.500 (p) | 4.938 (p) | 93.80 | 93.80 | independent |

### notes

- `sess-no-llm`: qa partial: correct=1/3；replay Fixed add.ts (a - b → a + b)；verify passed
- `sess-short-fluff` / `sess-mul-fix`: 真模型改文件 + verify 通过

## long

n=1 · mean composite=94.83 · mean m1=94.83

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-long-debug | 0.102 (p) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 4.667 (p) | 0.504 (p) | 94.83 | 94.83 | independent |

### notes

- replay Fixed add.ts: changed `a - b` to `a + b`. Verify passed

## multi_dead_end

n=1 · mean composite=96.30 · mean m1=96.30

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-multi-dead | 0.087 (p) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 4.800 (p) | 0.681 (p) | 96.30 | 96.30 | independent |

### notes

- replay Fixed subtraction-to-addition in add.ts；verify `python3 tests/test_add.py` passed
