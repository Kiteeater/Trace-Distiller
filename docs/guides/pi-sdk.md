# pi SDK 薄包

| 字段 | 内容 |
|------|------|
| 版本 | v0.2 |
| 日期 | 2026-09-09 |
| 状态 | **已收口**：pi 只当 sessions 洞内核；模型档走 env；失败重试 1 次再 Fail-Closed；本仓库仍不 import pi |
| 权威来源 | [ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)、[architecture.md](../architecture.md)「内核 / 三条活口」、[agent-sessions.md](../modules/agent-sessions.md) |

## 目的

钉死内核怎么接：**pi 只当两个 agent 洞里的会话内核**，不是 pi-coding 式 agent runtime，也不是 Distiller 自己的编排器。

直接用 pi SDK 的 `createAgentSession()`，只在 `src/agent/sessions/` 做薄包。切段、规则、编排、裁剪、存库、报告、live 订阅都是我们自己的 TypeScript。换内核时，代价限制在 `agent/sessions/`。

## 读者

- 写 `src/agent/sessions/` 的人（全仓库唯一允许 `import` pi 的地方）。
- 想在 orchestrator / eval / extension / live 里直接开会话的人——不要那样做。
- 做 P0 spike 的人：先验证三件最贵假设，再写正式封装。

## 已定结论

**不重开 [ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)。** Distiller 是流水线 + 两个洞；不要把 distill 编排交给 pi agent loop，不要做成「一个 Distiller Agent 在 pi 里跑完全程」。

1. **pi = sessions 洞内核，不是 agent runtime。** 两洞需要程序化嵌入的 LLM 会话；pi 原生 TS，支持多 provider。编排器是自写薄 CLI，不用 LangChain / CrewAI，也不用 pi 的 agent loop 当 orchestrator。
2. **`createAgentSession` 只允许在 `src/agent/sessions/`。** 文件是 `skeleton_pass.ts` / `label_window.ts` / `write_warrant.ts`（见 [file-architecture.md](./file-architecture.md)）。`extension.ts` 可以依赖 pi 的 **tool 类型**，但不许开会话。`eval/` 要干净会话，必须走 sessions 工厂。`service/live.ts` 不 import pi。可用 lint/grep 做门禁。
3. **薄包，不是框架。** 对外稳定的是 `skeletonPass` / `labelWindow`（以及 `writeWarrant`）和 L4 用的 `openSession` 工厂。见 [agent-harness.md](./agent-harness.md)。不要长出 `PiAgentRuntime`、中间件栈、图编排、pi-coding 式工具环。
4. **可扩展面（不必换目录）：**
   - **provider / 模型**：两洞走 pi provider 抽象；档位走 env / 入参，不写死在 skill。
   - **skill + 路由表**：策略在 `agent/skills/` Markdown；orchestrator 查 `constant/skill_route.ts`，模型不选文件。
   - **adapter**：新格式加在 `adapters/`，与 pi 无关。
   - **CutProfile**：声明式怎么剪；对话调 profile 是 M3 以后，且 agent 只能改 profile 再重跑流水线。
5. **三条活口（有意保留，目录不为此变形）：**
   - **换内核只换 `sessions/`。** pipeline 出现 `createAgentSession` 等于把活口焊死。
   - **`writeWarrant` 可改纯代码。** 现在可以走洞 A 角色的第二次调用；以后从 LabelDecision + CutProfile 汇总即可删 LLM，orchestrator 已把这步隔离。
   - **`rewrite_skill` 属 M3+。** 现在不加第三个判断力工具。
6. **结构化输出、骨架注入消息序列、provider 降档——文档代替不了 spike。** 没打勾之前，不要把「pi 一定能 JSON mode」写进实现当事实。

### pi 完成什么 / Distiller 自己完成什么

| 能力 | 谁 | 说明 |
|------|----|------|
| 创建 / 关闭一次 LLM 会话 | **pi** | `createAgentSession()`；**一窗一会话**（已拍板） |
| 多 provider（Anthropic / OpenAI / 自定义；Azure 可接） | **pi** | 打标升/降档后做 A/B；模型名走 env / 入参 |
| 自定义消息序列（骨架注入 system 或前置消息） | **pi**（待 spike） | 洞 B 每窗要带着骨架 context |
| 结构化 / JSON 模式输出 | **pi**（待 spike） | 优先走 SDK；失败则 Fail-Closed，不在洞里猜标签 |
| extension 工具挂载 | **pi** 提供挂载点；**我们**定义工具 | 蒸馏洞三工具已拍板闭集（[tools.md](./tools.md)）；handler 纯函数，本 PR 不挂 pi |
| Skills / Markdown 注入 | **pi 或自读文件**（待 spike） | 策略内容是我们的 `agent/skills/` |
| 流水线编排、切多少段、何时开洞、重试 | **Distiller** | orchestrator，纯 TS；**不**交给 pi agent loop |
| Action Unit 切段 / 规则打标 / 执行凭证 | **Distiller** | `pipeline/*` |
| SQLite / HTML 报告 / CutProfile / CLI / live 订阅 | **Distiller** | `data/`、`report/`、`service/`；sessions 只返回 `usage`，不写库 |
| Admission Gate、失败 Trace 拒绝 | **Distiller** | adapters；与 pi 无关 |

模型档位（已拍板 env 名，具体模型字符串由部署填）：洞 A 可用更强档；洞 B 日常打标；QA / L4 可降档。换模型走 provider 抽象，不换目录。

| 洞 / 角色 | 环境变量 |
|-----------|----------|
| 洞 A（骨架） | `TRACE_DISTILLER_MODEL_HOLE_A` |
| 洞 B（打标 / 衔接） | `TRACE_DISTILLER_MODEL_HOLE_B` |
| L4（QA / 重放 / review） | `TRACE_DISTILLER_MODEL_L4` |

失败：同一会话 **重试 1 次**（`PI_FAILURE_RETRY`），仍失败则编排器 **Fail-Closed Keep**。`createAgentSession` 仍只允许出现在 `src/agent/sessions/`。**本仓库不真正 import pi。**

## 怎么用 / 怎么跑

实现未开始。正确接法是 **先 spike，再薄包，再让 orchestrator 当普通函数调。**

### 包一层什么

`src/agent/sessions/` 对内可以碰 pi，对外只暴露：

```text
openSession({ role, model? })     → 句柄（eval 也走这里）
skeletonPass(input)               → 意图 / 场景 / 骨架 / usage
labelWindow(input)                → LabelDecision[] / patch / usage
writeWarrant(input)               → CutWarrant（可改纯代码）
checkContinuityPair(...)          → 衔接结果 / usage
openReviewSession / openReplaySession / openQaSession
```

薄包要做的事：

- 按 `AgentRole` 选模型与配额计数。
- 挂 extension、注入 skill 文本、注入骨架 context。
- 限制洞 A 可见 turns（头 + 验证点）。这是注意力设计的实现点，不是调用方的礼貌约定。
- 把工具调用拦下来变成 `LabelDecision`，而不是解析一篇散文。
- 解析失败向上抛；sessions 侧重试 1 次，仍失败让 orchestrator Fail-Closed。
- review 会话断言：消息里没有 warrant、没有骨架。

薄包不要做的事：切段、跑规则、执行裁剪、写 SQLite、选 skill 文件、决定窗口大小、推 live 进度、当 Distiller 的 agent loop。

### P0 spike 清单（先于正式封装）

TODO 原文：验证下面三件可用——「内核可换」活口依赖它。**这三项仍待 spike，本轮不假装已过。**

| # | 假设 | 怎样算通过 | 失败意味着什么 |
|---|------|------------|----------------|
| 1 | 结构化输出 | 一次会话稳定交出符合 schema 的 JSON / 工具参数，而不是自由文本 | Fail-Closed 会极频繁，洞 B 不可用；考虑强制 function call 或换内核 |
| 2 | 自定义消息序列 | 能把骨架（和 skill）注入每窗，且不把 RawTrace 全量塞进 prompt | 注意力设计落空；0009 的卡片流没有载体 |
| 3 | provider 降档切换 | 同一封装能换模型档位（洞 A 强档 / 洞 B 日常 / QA 降档）而不改调用方 | 「模型可换」活口是空话；档位只能写死 |

附加（不做完也可以开写 mock，但接真模型前要有结论）：

- extension 自定义工具能否按段调用；非法 Label 被拒。
- 是否用 pi Skills 机制还是 sessions 自读 Markdown。
- 一窗一 `createAgentSession` 已拍板；spike 只测耗时，不改成复用。

spike 用假 provider 或便宜档即可；要留下「三项打勾」的记录，不要只存在某次聊天里。

### 接进流水线之后怎么跑

1. orchestrator **不** `import` pi。它只 `await skeletonPass(...)` / `labelWindow(...)`。
2. `--no-llm` 用假 sessions，整条链路不碰 SDK。
3. eval 的 QA / 重放 / review：`openQaSession` 等工厂。盲测不给凭证。
4. 换假 provider 能跑通一次，再换真 key。
5. grep 门禁：`createAgentSession` 只出现在 `src/agent/sessions/`。

命令仍是 `node script/run-distill.ts distill <trace.jsonl> ...`。没有「pi 自己起一个 Distiller agent」的入口。

### 换内核时动哪里

只动 `agent/sessions/`（外加 extension 里的 tool **类型** 若绑死了 pi 的接口定义）。skill Markdown、CutProfile、assembler、SQLite schema、报告、live 都不该感知「现在是不是 pi」。若换内核需要改 orchestrator，说明活口已经漏了。

## 边界（非目标）

- 不把 distill 编排交给 pi agent loop；不重开 ADR-0008。
- 不引入 LangChain、CrewAI、或其他 agent 编排框架。
- 不在 pi 会话里跑流水线步骤，不让模型调用 assembler / 改 CutProfile / `edit_trace`。
- 不把 Distiller 做成 pi-coding 式 runtime（长会话、自管工具环、自己决定下一步）。
- 不把 pi 当 L0 原料格式的唯一来源。M1 优先 claude-code JSONL；`pi-session` 只是一种后续 TraceSource。
- 不把 L4 会话算成第三洞，也不允许 eval / live 绕过工厂自己开会话。
- 不在 spike 完成前把「JSON mode 一定可用」写进业务代码的 happy path 而不做 Fail-Closed。
- 不做 GUI、不做把 pi 包成在线服务。macaron 的 remote / middleware / observability 不抄。

## 开放问题

1. **P0 spike 尚未做。** 上表三项是真 OPEN，不是文档能关的。
2. 骨架注入挂在 system 还是前置消息：取决于 spike。
3. pi Skills vs 自读 `skills/*.md`：策略文件已定，加载机制未定。
4. 一窗一会话已拍板；成本未测，但不改成复用。
5. `read_segment` 注册成 pi tool 还是 sessions 侧 RPC：handler 纯函数已落地，挂载点等 spike。
6. 模型名只进 env（上表三变量），不进 constant。
7. 验证点 turn 的读取范围已由 ingest 给出 `anchor_turn_ids`。盲测协议已拍板（intent + playback；缺骨架节点代码回填 keep；最多 2 轮）；sessions 的 LLM 解析仍待 spike。

## 完成标准

- [ ] P0 spike 三项有书面结果（通过 / 失败 + 对策），再合入正式 sessions 封装。
- [ ] `createAgentSession`（及同等 SDK 入口）只出现在 `src/agent/sessions/`。
- [ ] `skeletonPass` 单测（mock pi）：prompt 含头/验证点，**不含**中间 full 原文。
- [ ] `labelWindow` 在工具不返回时失败，不捏造 Label。
- [ ] usage 带 `AgentRole`；换假 provider 能跑通一次。
- [ ] review 工厂注入消息无 warrant/skeleton。
- [ ] 换内核的 diff 可以限制在 `agent/sessions/`（code review 检查项，不是现在的实现项）。
- [ ] 仓库里没有「pi agent loop 编排 distill」的入口或目录。

## 相关文档

- [ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)
- [agent-harness.md](./agent-harness.md)
- [file-architecture.md](./file-architecture.md)
- [agent-sessions.md](../modules/agent-sessions.md)
- [TODO.md](../TODO.md) P0 工程骨架
