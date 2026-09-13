# Long smoke 记分板（2026-09-11 17:28）— 历史对照

| 字段 | 内容 |
|------|------|
| 标签 | 历史本地产物。JSON `mode=no_llm`，`l4=false`，`fake_l4=false` |
| 本地 mtime | 2026-09-11 17:28:30 +08 |
| 仓库 | 记分板 **未入库**。邻近 `e30d2c0`（2026-09-11 17:29，CutProfile 阀门 + long mint 脚本） |
| 命令 | 当时 long-only 扫描；**不是现行入口** |
| 源 | `benchmark/out-long-smoke/scoreboard.md` |

[ADR-0010](../../adr/0010-agent-led-cut-with-tool-mask.md) 已删除纯规则独立模式：现行 CLI 传入该历史开关会报错。CI 无密钥应走 `--fake-l4`。本文件只说明：无洞时 MIMO 压缩率 0.76–1.00（几乎不剪），合成 `sess-long-debug` 仍能压到 0.102。不要把下表当成可复现实验。

L4 全部 skipped（当时既没有 `--with-l4` 也没有 `--fake-l4`）。

---

# Trace-Distiller Benchmark Scoreboard

- datasets: `benchmark/datasets`
- distill mode: 当时记录为 `no_llm`（现行已删除）
- L4 qa/replay/coherence: skipped

Tracks are scored separately and **never averaged**.

## short

_no samples_

## long

n=8 · mean composite=0.00 · mean m1=11.85

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-long-debug | 0.102 (p) | 1.000 (p) | skip | skip | skip | 0.000 (p) | — | 94.83 | independent |
| claude-code:mimo-174fc63f | 0.766 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |
| claude-code:mimo-f221415e | 1.000 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |
| claude-code:mimo-d307bfb5 | 0.987 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |
| claude-code:mimo-8c09ef71 | 1.000 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |
| claude-code:mimo-7201fdae | 0.974 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |
| claude-code:mimo-03c7ff2d | 0.906 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |
| claude-code:mimo-8d031bf8 | 0.883 (f) | 1.000 (p) | skip | skip | skip | 0.000 (p) | 0.00 | 0.00 | independent |

### notes

- 各条：`l4 skipped: pass --with-l4 for real mint or --fake-l4 for CI (default avoids hang)`

## multi_dead_end

_no samples_
