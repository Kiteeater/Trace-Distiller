# 文件架构确认书

| 字段 | 内容 |
|------|------|
| 版本 | v0.1 |
| 日期 | 2026-09-07 |
| 状态 | 确认 architecture v0.3 目录树；不改架构 |
| 权威来源 | [architecture.md](../architecture.md) v0.3、[modules/](../modules/)、[TODO.md](../TODO.md) P0 |

## 目的

把一件事钉死：**[architecture.md](../architecture.md) v0.3 的目录树就是已定的文件模块架构。** 动工时按这棵树建目录，不要另起一套分层。

本文件是确认书 + 阅读地图，不是第二份 architecture。分层理由、选型、落地顺序仍以 architecture 为准；每个目录准做什么，以 [docs/modules/](../modules/) 的工程契约为准。契约已经有了，这里不重写成 types 字段说明书。

## 读者

- 准备写 `src/` 的人：先看「已定 / OPEN」表，OPEN 项没关就不要假装模块已完工。
- 读文档的人：分清 architecture（为什么这样切）、modules（这个目录的契约）、本文件（树锁没锁、缺什么）。

## 已定结论

1. **目录树已定。** architecture v0.3 那棵 `trace-distiller/` 树（`src/types` → `utils`，外加 `script/`、`tests/`、`examples/`、`data/`、`benchmark/`、`docs/`）就是文件模块架构。macaron-agent 分层纪律已裁进这棵树：契约前置、biz 与 service 分离、库操作走 data。不要在 `src/` 顶层再加 `runtime/`、`gateway/`、`agents/` 之类平行根。
2. **工程契约已有。** [docs/modules/](../modules/) 按树拆成可单独开工的设计文档。索引在 [modules/README.md](../modules/README.md)，路径对照在 [src/README.md](../../src/README.md)。guides 只确认「树 + 契约在哪」，不复制字段草图。
3. **主基调已定，目录为它服务。** 流水线 + 两个 agent 洞；编排纯 TS；pi 只经 `agent/sessions/`；展示层只有自包含 HTML。详见 [ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)、[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)。
4. **「契约已有」≠「字段已拍板」。** modules 里大量是草图。P0 结构体不定，segmenter / rules / 卡片流不能并行开工——这是 [TODO.md](../TODO.md) 的硬前置，不是文档写完就可以写实现。

一句话：

> 树锁了；契约文档锁了；JSON 字段和工程骨架还没锁。读 architecture 看树，读 modules 看边界，读 TODO P0 看还能不能动工。

## 怎么用 / 怎么跑

代码尚未开始（`src/` 为空，没有 `package.json`）。「跑」在这一层是指：**按树读、按树建、按表知道什么能写。**

### 怎么读（不要从零扫一遍 architecture）

| 你想知道 | 去哪 | 不要去哪 |
|----------|------|----------|
| 为什么是流水线不是一个 agent、目录为什么这样切 | [architecture.md](../architecture.md) | 本文件（不重写） |
| 某个 `src/` 目录准做什么、禁止什么 | [docs/modules/](../modules/) 对应篇 | architecture 的目录树（那只是名单） |
| 字段级 JSON 草图 | [modules/types.md](../modules/types.md)、[enums.md](../modules/enums.md) | 本文件 |
| 洞 A/B 怎么嵌 | [agent-harness.md](./agent-harness.md) | 把 Distiller 理解成 runtime agent |
| pi 包到哪一层 | [pi-sdk.md](./pi-sdk.md) | orchestrator / eval 里直接 `createAgentSession` |
| 什么还没拍板、动工卡在哪 | 下表 + [TODO.md](../TODO.md) P0 | 把 modules 草图当已实现 |

建议顺序：architecture「分层与职责」+ 本表 → 要对着干活的那篇 module → 相关 ADR。落地顺序仍用 architecture 那一节：契约 → L0+L1+SQLite → 无洞保守导出 → 报告骨架 → 洞 A → 洞 B → assembler → eval。

### 按树开工时怎么放文件

- 新文件必须落进已有叶子：`types/`、`enums/`、`constant/`、`domain/`、`adapters/`、`pipeline/`、`agent/sessions|extension|skills/`、`data/`、`eval/`、`service/`、`report/`、`utils/`，外加 `script/run-distill.ts`。
- 每个 enum 一个文件。architecture 点名的三个是下限；[enums.md](../modules/enums.md) 还列了 `focus` / `cut_action` 等，落地按 enums 契约拆，不要塞回一个 `enums.ts`。
- biz（`pipeline/`、`agent/`）不直接碰 SQLite；入口逻辑不写进 CLI；utils 只放无状态小函数。分层纪律见 [modules/README.md](../modules/README.md)。
- 跳过洞的通路是一等公民：orchestrator 在无 LLM / `--no-llm` 时仍应能导出保守 CutPlan。这是树里就有的能力，不是临时脚本。

命令形态（骨架落地后，现在不要创建 ts）：`node script/run-distill.ts distill <trace.jsonl> [--report out.html]`，见 [script-run-distill.md](../modules/script-run-distill.md)。

### 已定 / 仍 OPEN

「已定」= 目录职责、分层纪律、ADR 主基调已经锁，按这个建。「OPEN」= 契约草图有了，但 TODO P0 或 module 开放问题还没关，**不能当实现完成**。OPEN 一律链回 [TODO.md](../TODO.md)。

| 路径 | 职责（已定） | 状态 | OPEN 时去哪 |
|------|--------------|------|-------------|
| `src/types/` | RawTrace / AgentView / SegmentCard / CutPlan / CutWarrant / CutProfile | **OPEN** | [TODO.md](../TODO.md) P0 结构体：信封、卡片字段、`sig`、映射、凭证、profile；草图 [types.md](../modules/types.md) |
| `src/enums/` | 每 enum 一文件；Label 四类已定 | **部分已定** | Label / Focus / CutAction / AgentRole 取值已定；**Scenario 名单 OPEN**（[enums.md](../modules/enums.md) §6）；写成 TS 仍是 P0 |
| `src/constant/` | 压缩率区间、Fail-Closed、skill 路由表、默认 CutProfile | **部分已定** | `LABEL_WINDOW_SIZE`、span 数字、死胡同条数、Jaccard 阈值、路由表键都 OPEN（[constant.md](../modules/constant.md) §6） |
| `src/domain/` | LabelDecision / CutDecision / SpanViolation 纯模型 | **契约已有** | 不变量跟 types 一起钉；不阻塞「树」，阻塞「字段」 |
| `src/adapters/` | L0 解析 + Admission Gate | **职责已定** | **session ≠ trace** 切分策略是 P0；无 GT 拒绝已定（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)） |
| `src/pipeline/segmenter.ts` | Action Unit → 卡片骨架 | **职责已定** | 依赖 `sig` / 注意力默认档（P0）；无 GT 走不到这里 |
| `src/pipeline/rules.ts` | 规则打标、Jaccard 聚类、依赖图、默认 focus | **职责已定** | Jaccard 阈值、`sig`、失败调用是否误杀（[pipeline-rules.md](../modules/pipeline-rules.md) §6）；规则优先已定（[ADR-0002](../adr/0002-rule-first-labeling.md)） |
| `src/pipeline/orchestrator.ts` | 纯 TS 控制流，不 import pi | **已定** | 窗并行、`writeWarrant` 是否走 LLM、跳过洞 A 的正式开关（[pipeline-orchestrator.md](../modules/pipeline-orchestrator.md) §6） |
| `src/pipeline/assembler.ts` | 执行凭证、span、同源双产物 | **职责已定** | span 定量、collapse 在 Training 里的形状（M2）；原则已定（[ADR-0003](../adr/0003-dual-cut-outputs.md)、[ADR-0004](../adr/0004-span-constraint-reachable.md)） |
| `src/agent/sessions/` | **唯一 pi 依赖点**：`skeletonPass` / `labelWindow` | **已定** | [TODO.md](../TODO.md) P0 工程骨架里的 pi SDK spike（结构化输出 / 消息序列 / 降档）；`writeWarrant` 是否存在见 [agent-harness.md](./agent-harness.md) |
| `src/agent/extension.ts` | `label_segment` / `check_continuity`；另加确定性 `read_segment` | **职责已定** | `read_segment` 是 tool 还是 RPC 未在 ADR 关闭（[agent-extension.md](../modules/agent-extension.md) §6）；P0 要求有拉取闭环 |
| `src/agent/skills/` | 分场景 Markdown；MVP 3–5 个 | **活口已定** | 场景名单未拍板前不要用随便三个文件名冒充 M2 完成（[agent-skills.md](../modules/agent-skills.md)） |
| `src/data/` | SQLite：段 / 打标 / 凭证 / 指标；biz 不直接碰库 | **职责已定** | **列级 schema OPEN**（P0）；[data.md](../modules/data.md) 是草图 |
| `src/eval/` | L4 数字；干净会话走 sessions 工厂 | **职责已定** | token 口径、盲测判分协议是 P0；复合分见 benchmark，不进本树的「已实现」 |
| `src/report/` | 结果 JSON → 单个 `.html` | **已定** | 视觉细节非契约；M1 中段就要有骨架 |
| `src/service/` | CLI 薄壳 + 调 renderer | **已定** | argv 细节 OPEN；不做 TUI / web API |
| `src/utils/` | token 估算、jsonl、logger | **已定** | 官方 token 口径未定前必须标明「估算」 |
| `script/run-distill.ts` | 进程入口 | **已定** | 仓库还没有 package.json（P0 工程骨架） |
| `AGENTS.md` / `package.json` / tsconfig / eslint | 工程骨架 | **OPEN** | [TODO.md](../TODO.md) P0 工程骨架 |
| 展示 / GUI | 只有自包含 HTML | **已定不做** | 不做 Electron/Tauri、不做本地 web server |
| 编排框架 | 不用 LangChain / CrewAI | **已定不做** | 见 [ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md) |

architecture 有意保留的三条活口（skill 热更新、模型可换、内核可换）也已定：**目录不用为它们预留第四种形状**；内核可换只经 `agent/sessions/`，见 [pi-sdk.md](./pi-sdk.md)。

## 边界（非目标）

- 不重写 architecture，不在这里展开 L0–L4 的算法。
- 不把 modules 的字段草图再抄一遍。
- 不把 OPEN 项「确认」成已拍板。草图可以指导讨论，不能当 TS 已落地。
- 不引入新的顶层模块名（包括「Agent Gateway」「Distiller Runtime」）。接入门面仍叫 `adapters/`。
- 不在确认书里改树。要改目录，先改 architecture / ADR，再改本表。

## 开放问题

全部已在 TODO P0 或对应 module §6。本文件不新增问题，只标「挡开工」的那些：

1. **AgentView / SegmentCard / CutWarrant / CutProfile 字段**（P0 结构体）。树等它们，不是反过来。
2. **`sig`、注意力默认档、session ≠ trace、验证点定位、token 口径**（P0）。adapter / segmenter / rules / eval 都卡在这。
3. **工程骨架**：AGENTS.md、package.json、tsconfig、eslint、pi spike、SQLite schema、`read_segment`。
4. **Scenario 名单** → skill 文件名和 `SKILL_ROUTE` 才能写死。
5. **enums 文件集合**：严格三个 vs 按 enums.md 拆。建议按 enums.md，architecture 示例是下限。

## 完成标准

- [x] 目录树被明确写成「已定文件模块架构」，权威源指向 architecture v0.3。
- [x] 每个 `src/` 叶子都能链到一篇 module 契约。
- [x] 已定 vs OPEN 可扫表；OPEN 链到 TODO P0，不伪装成已实现。
- [ ] P0 结构体与工程骨架关闭后，把本表对应行改成「已定」或另开 ADR，而不是在 PR 里默默加目录。
- [ ] `src/` 开工后，顶层目录与 architecture 树一致（可用目录快照测试或 code review 对照本表）。
