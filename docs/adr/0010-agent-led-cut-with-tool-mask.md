# Agent 主编裁剪 + 工具掩码（Tool Mask）

## Status

accepted（2026-09-11）

**Supersedes**: [ADR-0008](./0008-pipeline-plus-two-agent-holes.md)

**Impact on other ADRs**:

- [ADR-0002](./0002-rule-first-labeling.md)：规则层不再是「优先、可独立跑通」的产品路径；规则变为 agent **可选调用的工具 / 提示**（segmenter/rules 仍可被 invoke），不是 `--no-llm` 独立模式。
- [ADR-0006](./0006-agent-orchestration-deterministic-tools.md)：曾被 0008 取代；本 ADR 再次确认「agent 拥有裁剪决策权」，但 **编排循环可落在 `src/agent/sessions/` 的 cut-brain 会话**，不是 pi-coding 产品循环，也不是 LangChain 一类框架。
- [ADR-0009](./0009-agent-view-and-cut-warrant.md)：AgentView / CutWarrant / 确定性 assemble+span 仍成立；变更的是「谁决定 how to cut」——由 agent session（editor-in-chief）深度理解意图并提议裁剪，确定性 TS 做准入、span 校验、凭证组装与 I/O。

## Context

ADR-0008 把 Distiller 定为「确定性流水线 + 两个 agent 洞」，并保留 `--no-llm` 纯规则保守路径以保证无密钥时可复现。实践中：

1. 「怎么切」需要意图理解与全局判断，规则层只能做局部启发式；纯规则路径会固化成二等公民，并把 Fail-Closed Keep 当成默认产品行为。
2. 洞工具若把完整 payload 回灌下一轮 agent 上下文，注意力与成本都会失控；全量原文应进 warrant / training store，而不是下一 turn 的 prompt。
3. Benchmark 仍要求 **admission / span / assemble / I/O** 可复现——这些必须留在确定性 TypeScript，不能交给 LLM 编排框架。

## Decision

1. **删除 `--no-llm` / 纯规则独立模式。** CLI 若传入 `--no-llm`，立即报错并指向本 ADR。蒸馏默认 / 强制走 **agent 路径**（`with_llm`）；CI / 无密钥用 `FakeSessionBackend` 或 `--fake-l4`，生产用洞模型 env。
2. **Agent session = editor-in-chief**：深度理解意图并决定 **how to cut**（提议 keep / collapse / drop 与标签）。Tools **只执行操作**（规则打标提示、读段、衔接检查、segmenter 等），不拥有最终裁剪叙事权。
3. **确定性 TS 保留**：Admission Gate、切段、span 检查、CutWarrant 组装、assemble 双产物、I/O / SQLite / report。Agent 提议之后，assembler / span 仍是校验器（hunch：规则可作为 agent 可调用工具；assemble/span 保持确定性）。
4. **Tool mask 契约**：工具结果 **不得** 完整回到下一轮 agent prompt。`maskToolResult(raw) → masked` 做 summarize / truncate / structure；完整 payload 可写入 warrant / training store，不进下一 turn。实现见 `src/agent/sessions/tool_mask.ts`。
5. **Fail-Closed 策略调整**：不再等于「无洞则全 keep」。未决议段保持 unresolved，直到 agent 打标，或显式调用 keep 工具；agent/tool 失败时的保守策略仍由编排器执行，但语义是 **agent/tool failure policy**，不是规则优先模式。
6. **pi 边界不变**：仍只允许出现在 `src/agent/sessions/`。该目录可托管 cut-brain 会话循环（非 pi-coding 产品循环）。

## Consequences

- 文档与 `AGENTS.md` 不再写「这不是一个 agent / 编排永远不用 LLM / `--no-llm` 一等公民」。
- `resolveDistillMode` 拒绝 `--no-llm`；无后端且无洞模型 env 时要求 agent 路径（报错），不静默退回规则-only。
- Bench 防挂：无 `--with-l4` 时默认注入 `FakeSessionBackend`（agent 路径 + 假后端），不再靠 `--no-llm`。
- **Phase 2（本 follow-up）**：cut-brain ReAct 会话拥有未决议标签；`apply_rules_hint` / `keep_segment` 经 tool_mask；orchestrator 不再静默 `applyRules` 并进最终 decisions。Admission / assemble / span 仍确定性。
- **洞 A 演进**：固定头/验证点一枪采样由 [ADR-0011](./0011-hole-a-sparse-sampling-intent.md) 锁定为多轮稀疏采样（分层锚点池 + gaps；洞 A 不产出 keep/collapse/drop）。

## TODO / skeleton（follow-up）

- [x] `src/agent/sessions/` 内 cut-brain session loop（propose cut → tool calls → mask → iterate）
- [x] 将 `applyRules` 暴露为 agent 可调用工具 `apply_rules_hint`（可选 hints；segmenter 仍为预处理，不是工具）
- [x] Fail-Closed：显式 `keep_segment` + unresolved 直到 agent 决议（编排器 failure policy）
- [ ] warrant/training store 存 full tool payloads；prompt 只吃 masked（store 仍 M2+）
- [ ] 洞 A 多轮稀疏采样落地：见 [ADR-0011](./0011-hole-a-sparse-sampling-intent.md)（先分层池+多轮+硬预算+结构化 enough；向量效率分另 PR）
