# Agent 目录：tools / prompt / sessions

## Status

accepted（2026-09-14）

**Related**:

- [ADR-0008](./0008-pipeline-plus-two-agent-holes.md)（流水线 + 两洞；编排不交给 pi agent loop）
- [ADR-0010](./0010-agent-led-cut-with-tool-mask.md)（agent 主编 + tool mask；`--no-llm` 已删；PR#68 六条不变量）
- [ADR-0011](./0011-hole-a-sparse-sampling-intent.md) / [ADR-0012](./0012-hole-b-single-slot-progressive-disclosure.md)（洞 A 稀疏采样；洞 B 单槽 focus=1 + 渐进披露）
- [ADR-0015](./0015-distill-cost-roi.md)（蒸馏成本 / ROI；不复活 `--no-llm`）
- [pi-sdk.md](../guides/pi-sdk.md)（pi = sessions 洞内核，薄包，不是 pi-coding 产品 runtime）
- [file-architecture.md](../guides/file-architecture.md)（叶子树；改目录先改那一页）
- PR#68 architecture enforcement（`createAgentSession` / `@mariozechner/pi*` 仅 `src/agent/sessions/`；extension 不 import pi）

本 ADR **授权目录与层边界**。代码搬家已在 follow-up 落地：`src/agent/tools/`（registry + `defineTool` 适配）与 `src/agent/prompt/`（compose + tool_mask）；旧路径留 re-export shim。

## Context

PR#68 之后，`src/agent/` 除 `skills/` 与 `extension.ts` 外，洞循环、pi 工厂、prompt 拼装、tool mask、pi `defineTool` 适配都挤在 `sessions/`：

```text
src/agent/
  extension.ts          # LOCKED 洞工具名 + 纯函数 handlers
  skills/               # Markdown skills
  sessions/
    open_session.ts     # createAgentSession 工厂；composeSessionPrompt；maskPromptMessageContent
    hole_tools.ts       # buildHoleCustomTools + resolvePiToolRegistration（pi defineTool）
    tool_mask.ts        # ADR-0010 maskToolResult / ACK 断言
    cut_brain.ts / cut_brain_harness.ts
    sparse_intent.ts / candidate_pool.ts / skeleton_pass.ts
    label_window.ts / write_warrant.ts / card_index.ts
    l4_qa.ts / l4_replay.ts / l4_review.ts
```

现行接线：

- `open_session` → `hole_tools.resolvePiToolRegistration` → `customTools` / `noTools`
- `hole_tools.execute` 只 ACK（经 `tool_mask`）；编排器事后从 `tool_calls` 跑 `extension` handlers
- `composeSessionPrompt`：system + skill_text + skeleton_text（相对稳定的前言）→ 已掩码 messages → user `text`；全部活在约 1500 行的 `open_session.ts`

这套行为（闭集、ACK/mask、单槽、骨架保护、agent-led）由 PR#68 测试锁死，**不得借拆目录放松**。需要拆的是注意力与依赖边界：

1. 洞循环（pipeline）与工具注册 / prompt 拼装混在同一目录，sessions 会继续膨胀，后续无法把「调工具」和「组 prompt」收成单一入口。
2. Prompt 把不稳定的 user / evidence 与极少变的 system+skill 揉在一起，不利于 KV-cache 友好的稳定前缀。
3. 命名应对齐 [pi-sdk.md](../guides/pi-sdk.md)：pi-agent **层**（tools / prompt / pipeline）用 Distiller 目录名落地；pi **仍只是 sessions 洞内核**，不是 Distiller 产品 runtime，也不是 LangChain / CrewAI 编排器。

## Decision

### 1. 目录布局（授权 `src/agent/` 新叶子）

目标树：

```text
src/agent/
  tools/           # 工具层：registry + executors（+ 可选 pi defineTool 适配）
  prompt/          # Prompt 层：compose、稳定前缀、大 payload 掩码
  sessions/        # Pipeline / 洞循环（cut_brain、sparse_intent、L4、open_session 工厂）
  skills/          # Markdown skills（不变）
  extension.ts     # 可保留为 re-export shim，或薄类型/闭集名表面（迁移 PR 二选一）
```

**显式允许**新叶子：`src/agent/tools/`、`src/agent/prompt/`。

**仍禁止**：`src/gateway/`、`src/runtime/`、`src/biz/`、`src/agents/`。接入门面仍是 `adapters/`；macaron 的 `biz/` 仍是 `pipeline/` + `agent/`。本拆分 **不是** 复活 runtime agent 产品叙事。

本 ADR 合入时叶子已授权；follow-up 已把 `hole_tools` / `tool_mask` / `composeSessionPrompt` 迁入 `tools/` 与 `prompt/`。`sessions/hole_tools.ts` 与 `sessions/tool_mask.ts` 现为 re-export shim。

### 2. 工具层

- **Registry 是唯一入口。** sessions / cut-brain / sparse_intent / L4 调洞工具必须走 registry；禁止绕过 registry 对洞工具 ad-hoc `defineTool`，也禁止直接调 raw handlers。
- Registry **负责 dispatch 执行**（到 `extension` handlers / executors）。pi `customTools` 的 execute 路径也必须经 registry（ACK + mask **仍强制**）。
- 工具名闭集仍 LOCKED：`label_segment` / `check_continuity` / `keep_segment` / `read_segment` / `apply_rules_hint`。禁止 `edit_trace` / `drop_segment`。
- **PR#68 / pi 边界**：`createAgentSession` **仍只允许**出现在 `src/agent/sessions/`（今日：`open_session.ts`）。session API（开会话、跑 turn）不离开 `sessions/`。
  - **优先**：`tools/` 只放纯 registry + executors（**不** `createAgentSession`）。
  - 若 `@mariozechner/pi-coding-agent` 的 `defineTool` / `ToolDefinition` 必须落在 `tools/`，迁移 PR **可以收窄地**把 import allowlist 扩到 `src/agent/tools/`，**仅限这两个符号**；仍禁止 `createAgentSession` 与 pi session API 出现在 `sessions/` 之外。测试必须显式改断言，禁止静默放宽。
  - **亦可**：在 `sessions/` 留一层薄 pi adapter，只根据 registry 组 `customTools`。只要 registry 仍是唯一 dispatch 入口，两种都合格。
- `extension.ts` handlers 仍是纯函数，不接 pi、不写 SQLite、不拥有裁剪权。

### 3. Prompt 层（KV-cache 友好）

Composer 落在 `src/agent/prompt/`。顺序 **稳定 → 不稳定**，禁止把不稳定的 user / evidence 拍进稳定前缀：

1. **稳定前缀**：system + skill（以及其它极少变的政策文本）
2. **会话状态指针**：skeleton / card_index / focus pointers / 紧凑状态——**不是**巨型 blob（对齐 ADR-0012：S0 骨架是计数与指针，不是全量 id 墙）
3. **不稳定**：本轮 user 文本 + evidence cards / 已披露 payload

**大 payload 在 prompt 层掩码。** 与现有 `tool_mask` / `maskPromptMessageContent` / `assertAckOrMaskedToolMessage` 绑定；迁移时可将 mask 挪到 `prompt/`，或在 `tools/` + `prompt/` 下共享再 re-export。全量 raw tool body **仍不得**进入下一 agent turn（ADR-0010 / 0012）。全量可进 warrant / training store。

今日 `composeSessionPrompt` 把 system + skill + skeleton 揉进同一前言，是迁移起点，不是本 ADR 要固化的最终形状。

### 4. Sessions / pipeline

- 洞循环留在 `sessions/`：`cut_brain`、`sparse_intent`、L4、`open_session` 工厂。
- Sessions **只经 registry 调工具**；**只经 prompt composer 组 prompt**。
- Orchestrator 仍是 `pipeline/` 里的纯 TypeScript；禁止 LangChain / CrewAI；pi 不是编排器。

### 5. 非目标 / 不得削弱

本拆分 **不改变产品行为**，也不重开已锁决策：

- **不**复活 `--no-llm` / 静默 rules-only。
- **不**放松 compress 门，也 **不**把范围扩成完整 SFT。
- **不**削弱 PR#68 / ADR-0010 / 0012 不变量：
  - `mergeAdoptedWithBrain` / `assertNoRuledOverwrite`（`RULED_OVERWRITE_REFUSED`）
  - cut-brain `focus=1`（同轮 multi-focus + disclose 计 violation）
  - ACK / mask 断言（`assertAckOrMaskedToolMessage`；非长度-only 的 `maskPromptMessageContent`）
  - 骨架 `skeleton_protect`（规则禁 drop/collapse）
  - agent 路径强制（`assertAgentLedMode`）
- 破坏上述不变量的测试必须红。禁止 LangChain / CrewAI。
- 先行为保持迁移（旧路径 re-export shim 合格），再接线 registry + composer。

## Consequences

- [file-architecture.md](../guides/file-architecture.md) 授权 `src/agent/tools/` 与 `src/agent/prompt/`；树与叶子表同步本 ADR。代码未搬家前，目录可以空。
- Distiller-owned prompt history prune 落在 `prompt/compact.ts`（保留 S0 指针 + 最近 ACK/masked 轮次；旧证据只在 compose 丢掉）。这不是 pi compact / LLM 摘要；store/warrant 仍保留全量 payload。
- [AGENTS.md](../../AGENTS.md) 把 agent 布局写成 tools（registry）/ prompt（KV-friendly compose+mask）/ sessions（洞循环）；registry 为洞工具唯一入口。
- pi 边界文档（[pi-sdk.md](../guides/pi-sdk.md)）：`createAgentSession` 仍只在 `sessions/`。若迁移把 `defineTool` 放进 `tools/`，architecture 测试 **故意**收窄放行那两个符号，而不是把 `@mariozechner/pi*` 整包放开。
- 洞工具闭集、ACK/mask、单槽、骨架保护、agent-led、L4 不计蒸馏成本——全部原样。本 ADR 不改 CutPlan / warrant / 记分板公式。
- `extension.ts` 可以暂时留在 `src/agent/` 根上；handlers 仍禁止 import pi。

## TODO（代码迁移；非本 ADR PR）

Follow-up PR 必须引用本 ADR，并保持测试绿（含 architecture enforcement）：

- [x] 新增 `src/agent/tools/` 与 `src/agent/prompt/`；把 `hole_tools` / mask / compose 片段迁入，旧路径留 re-export shim **或**干净改 import。
- [x] 落地 registry：dispatch 到 extension handlers；pi `customTools` execute 走 registry（ACK + mask 强制）。
- [x] `open_session` / cut-brain / sparse_intent / L4 **只**经 registry 调洞工具，**只**经 prompt composer 组 prompt。
- [x] Composer 按稳定前缀 → 状态指针 → 不稳定证据的顺序拼装；不稳定内容不进稳定前缀。
- [x] 若 `defineTool` / `ToolDefinition` 落在 `tools/`：收窄更新 architecture 测试 allowlist（仅这些符号；`createAgentSession` 仍只在 `sessions/`）。若 adapter 留在 `sessions/`，测试 allowlist 不扩。
- [x] 同步 [file-architecture.md](../guides/file-architecture.md) 叶子文件名、[AGENTS.md](../../AGENTS.md)、[pi-sdk.md](../guides/pi-sdk.md) 与实际路径（本 ADR 已授权目录；搬家后改文件名行）。
- [x] 行为保持：不复活 `--no-llm`；不放松 compress / SFT 范围；不削弱 ruled-overwrite / focus=1 / ACK-mask / skeleton_protect / agent-path。
