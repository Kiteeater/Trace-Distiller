# Real mint 记分板（2026-09-11 14:13，short + 合成 long/multi）

| 字段 | 内容 |
|------|------|
| 标签 | **real mint**（`--with-l4`，非 Fake） |
| 本地 mtime | 2026-09-11 14:13:39 +08 |
| 仓库 | 记分板 **未入库**。mtime 落在 `f4c5cf9`（2026-09-11 06:04，maturity + overnight bench）之后、`c656c49`（15:21，mint 根因 + long MIMO）之前。**没有**可引用的生成 SHA |
| 命令 | `node script/run-distill.ts bench --with-l4`（当时默认扫三档；本板 long/multi 各 1 条合成样，尚无 MIMO） |
| 源 | `benchmark/out-mint/scoreboard.md`（`mode=with_llm`，`fake_l4=false`） |

呈现早于 ADR-0014：fail 样本 composite/m1 印成 `0.00`。现行应为 `—`。当时尚无 cost 软门的「只报不分」在 short 上把 composite 救回来——三条 short 的 cost 均 fail，composite 全 0。

---

# Trace-Distiller Benchmark Scoreboard

- datasets: `benchmark/datasets`
- distill mode: `with_llm`
- L4 qa/replay/coherence: attempted

Tracks are scored separately and **never averaged**.

> **M1 vs composite:** `m1_score` = 压缩率得分 × 关键步召回（M1 硬门禁）。`composite` 仍要求六项全过（含 cost≤0.3）。短 trace 真 mint 常因处理成本比偏高使 `composite=0`；compress+recall 过时看 `m1_score` 判断 M1 是否成功。

## short

n=3 · mean composite=0.00 · mean m1=41.41

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-no-llm | 0.382 (f) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 3.500 (f) | 47.806 (f) | 0.00 | 0.00 | independent |
| claude-code:sess-short-fluff | 0.015 (p) | 1.000 (p) | 1.000 (p) | 0.000 (f) | 5.000 (p) | 2.159 (f) | 0.00 | 30.44 | independent |
| claude-code:sess-mul-fix | 0.047 (p) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 4.500 (p) | 4.650 (f) | 0.00 | 93.80 | independent |

### notes

- `sess-no-llm`: replay Fixed add.ts: changed `a - b` to `a + b`. Verify (python3 tests/test_add.py) passed
- `sess-short-fluff`: qa partial: correct=0/0；replay 同样修好 add.ts 并通过 verify
- `sess-mul-fix`: replay Fixed mul.ts: replaced `a + b` with `a * b`. Verify `python3 tests/test_mul.py` passed

## long

n=1 · mean composite=0.00 · mean m1=10.70

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-long-debug | 0.005 (p) | 1.000 (p) | 0.000 (f) | 1.000 (p) | 3.500 (f) | 0.508 (f) | 0.00 | 10.70 | independent |

### notes

- replay failed: `runReplay: failed to parse structured JSON (Unexpected token 'T', "The bug is"... is not valid JSON)`
- replay verify ok: python3 tests/test_add.py（verify 过了，但结构化 JSON 解析失败 → replay 记 fail）

## multi_dead_end

n=1 · mean composite=0.00 · mean m1=12.19

| trace | compress | recall | replay | qa | coherence | cost | composite | m1 | gold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-code:sess-multi-dead | 0.006 (p) | 1.000 (p) | 1.000 (p) | 1.000 (p) | 3.500 (f) | 0.573 (f) | 0.00 | 12.19 | independent |

### notes

- replay Fixed add.ts subtraction→addition；verify passed
