# 洞 A 决策改走 TypeSafe Jev

## Status

accepted（2026-09-22）

**Related**:

- [ADR-0011](./0011-hole-a-sparse-sampling-intent.md)（分层候选池 + 多轮稀疏采样 + 硬预算；本 ADR 只换决策后端）
- [ADR-0010](./0010-agent-led-cut-with-tool-mask.md)（`read_segment` 结果仍走 tool mask；洞 A 不产出 keep/collapse/drop）

## Context

ADR-0011 的洞 A 要的是结构化 `{ enough, intent_v0, scenario, skeleton_points, uncertainty, gaps? }`，不是一段自由散文。现行实现把这些字段交给 pi 生成式 Hole A 一次吐 JSON。采样循环（候选池、每轮抽样、硬预算、`read_segment`）已经是确定性代码；真正不稳定的是「够不够 / 哪个场景 / 哪些段是骨架点」。

TypeSafe Jev 的 `systemOne` 一次调用对同一份 state 并行回答 Choice / Score / Noul。这和洞 A 的闭集决策对齐：场景是枚举，enough 是是/否概率，uncertainty 是有序等级，骨架点是对候选 id 的是/否。生成式 `intent_v0` 散文可以降级。

不用 OpenJev 或其它克隆。只使用 TypeSafe 的 Choice / Score / Noul。

## Decision

1. **采样不变**。`buildCandidatePool` / `sampleCandidates`、硬预算（轮数、已读段数、token）、`read_segment` + tool mask 仍是洞 A 外环。洞 A 仍不产出 keep / collapse / drop。
2. **决策改走 Jev**。每轮把卡片索引和掩码摘录收成一份 compact `state`，一次 `POST {base}/v1/systemone`（`@typesafe-ai/sdk` 把 `baseURL` 接到 `/v1/systemone`，只去掉末尾斜杠）：
   - `enough`：Noul
   - `scenario`：Choice，选项是 `SCENARIOS`
   - `uncertainty`：Score，有序等级再映射到 0–1
   - 下一轮缺口：未读 id 不多时 Choice 选 id，否则 Choice 选分层
   - 骨架点：对本轮已读候选各问一个 Noul，kind 用 Choice（`SkeletonNodeKind`）
3. **`intent_v0` v1 是模板**。`{scenario}: sparse skeleton over N key point(s)`，后面最多接三条骨架 note（卡片 head，不是模型散文）。生成式意图正文推迟。审计 note：`intent_v0:template`。
4. **后端选择** `TRACE_DISTILLER_HOLE_A_DECISION=jev|pi`：
   - 显式 `decision` 优先，其次该 env
   - 注入了 Jev client → jev
   - 注入了 SessionBackend（参数或 `setSessionBackend` / `--fake-l4`）→ pi，避免打乱现有 Fake Hole A 骨架
   - 否则 **jev**
   - jev 且有 key → `@typesafe-ai/sdk` 的 `TypeSafeClient.systemOne`
   - key 顺序：`TRACE_DISTILLER_JEV_API_KEY`，然后 `TYPESAFE_API_KEY`，然后 `TRACE_DISTILLER_API_KEY`（与 pi 网关同一把钥匙）。空白不算
   - base：`TRACE_DISTILLER_JEV_BASE`，否则 `TRACE_DISTILLER_API_BASE`，否则 `https://api.typesafe.ai`。传给 SDK 前去掉末尾 `/` 和一层末尾 `/v1`。mint-alpha 的 `https://mint-alpha.macaron.im/v1` 因此打到 `https://mint-alpha.macaron.im/v1/systemone`
   - 模型：`TRACE_DISTILLER_JEV_MODEL`，缺省 `jev`（mint 上的 model id）。公网 TypeSafe 可改钉 `jev-latest` 或 `jev-1.13.0`
   - jev 且没有 key → `FakeJevClient`，不联网。测试和 CI 走这条
5. 审计字段仍是 `enough` / `rounds` / `segments_read` / `gaps` / `uncertainty`。硬预算到了必须停，并抬高 uncertainty。

## Consequences

- 无 SessionBackend 的生产蒸馏，洞 A 默认不再调用 `TRACE_DISTILLER_MODEL_HOLE_A`。要回到生成式洞 A，设 `TRACE_DISTILLER_HOLE_A_DECISION=pi`。
- Live Jev 走现有 mint 网关。`.env` 里 `TRACE_DISTILLER_API_BASE=https://mint-alpha.macaron.im/v1` 与 `TRACE_DISTILLER_API_KEY` 已够；洞 A 默认模型是 `jev`。
- `--fake-l4` 仍注入 FakeSessionBackend，洞 A 保持 pi fake 骨架，bench 行为不变；要在 fake-l4 上改走 Jev，显式设 `TRACE_DISTILLER_HOLE_A_DECISION=jev`（无 key 则 FakeJev）。
- 洞 B / L4 不在本决策范围，仍走 pi session。
- 向量效率分仍只做 bench，不作在线停机信号。
