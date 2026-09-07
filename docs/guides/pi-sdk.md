# pi SDK 薄包

| 字段 | 内容 |
|------|------|
| 版本 | v0.1 |
| 日期 | 2026-09-07 |
| 状态 | 选型已定；SDK 能力待 P0 spike 验证 |
| 权威来源 | [architecture.md](../architecture.md)「内核 / 技术选型 / 三条活口」、[agent-sessions.md](../modules/agent-sessions.md)、[TODO.md](../TODO.md) P0 工程骨架 |

## 目的

钉死内核怎么接：**直接用 pi SDK 的 `createAgentSession()`，在 `agent/sessions/` 做薄包，不引入任何 agent 框架。**

Distiller 不是 pi 应用，也不是「pi 上面再套一层 LangChain」。pi 只负责洞里那次会话；切段、规则、编排、裁剪、存库、报告都是我们自己的 TypeScript。换内核时，理论代价限制在 `agent/sessions/`。

## 读者

- 写 `src/agent/sessions/` 的人（全仓库唯一允许 `import` pi 的地方）。
- 想在 orchestrator / eval / extension 里直接开会话的人——不要那样做。
- 做 P0 spike 的人：先验证三件最贵假设，再写正式封装。

## 已定结论

1. **内核 = pi SDK。** 两洞需要程序化嵌入的 LLM 会话；pi 原生 TS，支持多 provider。编排器是自写薄 CLI，不用 LangChain / CrewAI（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。
2. **薄包，不是框架。** 需要对外稳定的只有 `skeletonPass` / `labelWindow`（建议还有 `writeWarrant`）以及 L4 用的 `openSession` 工厂。见 [agent-harness.md](./agent-harness.md)。不要在仓库里长出 `PiAgentRuntime`、中间件栈、图编排。
3. **import 边界已定。** 唯一允许 `createAgentSession` 的目录是 `src/agent/sessions/`。`extension.ts` 可以依赖 pi 的 **tool 类型**，但不许开会话。`eval/` 要干净会话，必须走 sessions 工厂，不能自己调 SDK。可用 lint/grep 做门禁。
4. **换内核活口已定。** architecture 三条活口之一：编排器与洞之间只经 `agent/sessions/`；pi 撑不住时替换成本限制在该目录。pipeline 出现 `createAgentSession` 等于把活口焊死。
5. **结构化输出、自定义消息序列、provider 降档——文档代替不了 spike。** TODO P0：「内核可换」最贵的假设最先验。没打勾之前，不要把「pi 一定能 JSON mode」写进实现当事实。

### pi 完成什么 / Distiller 自己完成什么

| 能力 | 谁 | 说明 |
|------|----|------|
| 创建 / 关闭一次 LLM 会话 | **pi** | `createAgentSession()`；一窗一会话（MVP 建议） |
| 多 provider（Anthropic / OpenAI / 自定义；Azure 可接） | **pi** | 打标升/降档后做 A/B；模型名走 env / 入参，不写死在 skill |
| 自定义消息序列（骨架注入 system 或前置消息） | **pi**（待 spike） | 洞 B 每窗要带着骨架 context；具体挂在 system 还是前置消息看 spike |
| 结构化 / JSON 模式输出 | **pi**（待 spike） | 优先走 SDK 能力；失败则 Fail-Closed，不在洞里猜标签 |
| extension 工具挂载 | **pi** 提供挂载点；**我们**定义工具 | `label_segment` / `check_continuity` / 确定性 `read_segment` |
| Skills / Markdown 注入 | **pi 或自读文件**（待 spike） | 策略内容是我们的 `agent/skills/`；机制等 spike |
| 流水线编排、切多少段、何时开洞、重试 | **Distiller** | orchestrator，纯 TS |
| Action Unit 切段 | **Distiller** | `pipeline/segmenter` |
| 规则打标、聚类、依赖图、默认注意力档 | **Distiller** | `pipeline/rules` |
| 执行 CutWarrant、span、同源投影 | **Distiller** | `pipeline/assembler` |
| SQLite 段队 / 标签 / 凭证 / 用量 | **Distiller** | `data/`；sessions 只返回 `usage`，不写库 |
| 自包含 HTML 报告 | **Distiller** | `report/` |
| CutProfile / CLI | **Distiller** | `types` + `service`；对话调 profile 是 M3 以后，且 agent 只能改 profile |
| 预算分账、Fail-Closed Keep、skill 路由 | **Distiller** | 见 harness；pi 不知道 CutProfile 或 `SKILL_ROUTE` |
| Admission Gate、失败 Trace 拒绝 | **Distiller** | adapters；与 pi 无关 |

模型档位（已定原则，具体名字 OPEN）：洞 A 可用更强档；洞 B 日常打标；QA 可降档。换模型走 provider 抽象，不换目录。

## 怎么用 / 怎么跑

实现未开始。正确接法是 **先 spike，再薄包，再让 orchestrator 当普通函数调。**

### 包一层什么

`src/agent/sessions/` 对内可以碰 pi，对外只暴露：

```text
openSession({ role, model? })     → 句柄（eval 也走这里）
skeletonPass(input)               → 意图 / 场景 / 骨架 / usage
labelWindow(input)                → LabelDecision[] / patch / usage
writeWarrant(input)               → CutWarrant（建议；可删）
checkContinuityPair(...)          → 衔接结果 / usage
openReviewSession / openReplaySession / openQaSession
```

薄包要做的事：

- 按 `AgentRole` 选模型与配额计数。
- 挂 extension、注入 skill 文本、注入骨架 context。
- 限制洞 A 可见 turns（头 + 验证点）。这是注意力设计的实现点，不是调用方的礼貌约定。
- 把工具调用拦下来变成 `LabelDecision`，而不是解析一篇散文。
- 解析失败向上抛，让 orchestrator Fail-Closed。
- review 会话断言：消息里没有 warrant、没有骨架。

薄包不要做的事：切段、跑规则、执行裁剪、写 SQLite、选 skill 文件、决定窗口大小。

### P0 spike 清单（先于正式封装）

TODO 原文：验证下面三件可用——「内核可换」活口依赖它。

| # | 假设 | 怎样算通过 | 失败意味着什么 |
|---|------|------------|----------------|
| 1 | 结构化输出 | 一次会话稳定交出符合 schema 的 JSON / 工具参数，而不是自由文本 | Fail-Closed 会极频繁，洞 B 不可用；考虑强制 function call 或换内核 |
| 2 | 自定义消息序列 | 能把骨架（和 skill）注入每窗，且不把 RawTrace 全量塞进 prompt | 注意力设计落空；0009 的卡片流没有载体 |
| 3 | provider 降档切换 | 同一封装能换模型档位（洞 A 强档 / 洞 B 日常 / QA 降档）而不改调用方 | 「模型可换」活口是空话；档位只能写死 |

附加（不做完也可以开写 mock，但接真模型前要有结论）：

- extension 自定义工具能否按段调用 `label_segment`，非法 Label 被拒。
- 是否用 pi Skills 机制还是 sessions 自读 Markdown。
- 一窗一 `createAgentSession` 的真实耗时 / 连接成本，好决定要不要复用会话。

spike 用假 provider 或便宜档即可；要留下「三项打勾」的记录，不要只存在某次聊天里。

### 接进流水线之后怎么跑

1. orchestrator **不** `import` pi。它只 `await skeletonPass(...)` / `labelWindow(...)`。
2. `--no-llm` 用假 sessions，整条链路不碰 SDK。
3. eval 的 QA / 重放 / review：`openQaSession` 等工厂。盲测不给凭证。
4. 换假 provider 能跑通一次，再换真 key。
5. grep 门禁：`createAgentSession` 只出现在 `src/agent/sessions/`。

命令仍是 `node script/run-distill.ts distill <trace.jsonl> ...`。没有「pi 自己起一个 Distiller agent」的入口。

### 换内核时动哪里

只动 `agent/sessions/`（外加 extension 里的 tool **类型** 若绑死了 pi 的接口定义）。skill Markdown、CutProfile、assembler、SQLite schema、报告都不该感知「现在是不是 pi」。若换内核需要改 orchestrator，说明活口已经漏了。

## 边界（非目标）

- 不引入 LangChain、CrewAI、或其他 agent 编排框架。
- 不在 pi 会话里跑流水线步骤，不让模型调用 assembler / 改 CutProfile / `edit_trace`。
- 不把 pi 当 L0 原料格式的唯一来源。adapters 仍要接 claude-code / SWE-bench；`pi-session` 只是一种 TraceSource。
- 不把 L4 会话算成第三洞，也不允许 eval 绕过工厂。
- 不在 spike 完成前把「JSON mode 一定可用」写进业务代码的 happy path 而不做 Fail-Closed。
- 不做 GUI、不做把 pi 包成在线服务。macaron 的 remote / middleware / observability 不抄。

## 开放问题

1. **P0 spike 尚未做。** 上表三项是真 OPEN，不是文档能关的。
2. 骨架注入挂在 system 还是前置消息：取决于 spike。
3. pi Skills vs 自读 `skills/*.md`：策略文件已定，加载机制未定。
4. 一窗一会话 vs 复用：architecture 写前者；成本与状态泄漏未测。
5. `read_segment` 注册成 pi tool 还是 sessions 侧 RPC（[agent-extension.md](../modules/agent-extension.md) §6）。
6. 模型名进 constant 还是只进 env（[constant.md](../modules/constant.md) §6）。
7. 验证点 turn、review 答卷格式未定，sessions 无法实现对应解析。

## 完成标准

- [ ] P0 spike 三项有书面结果（通过 / 失败 + 对策），再合入正式 sessions 封装。
- [ ] `createAgentSession`（及同等 SDK 入口）只出现在 `src/agent/sessions/`。
- [ ] `skeletonPass` 单测（mock pi）：prompt 含头/验证点，**不含**中间 full 原文。
- [ ] `labelWindow` 在工具不返回时失败，不捏造 Label。
- [ ] usage 带 `AgentRole`；换假 provider 能跑通一次。
- [ ] review 工厂注入消息无 warrant/skeleton。
- [ ] 换内核的 diff 可以限制在 `agent/sessions/`（code review 检查项，不是现在的实现项）。
