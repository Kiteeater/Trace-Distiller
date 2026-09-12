# 文件架构确认书

| 字段 | 内容 |
|------|------|
| 版本 | v0.2 |
| 日期 | 2026-09-09 |
| 状态 | **已收口**：叶子文件树已拍板；分层纪律仍以 architecture v0.3 为准 |
| 权威来源 | 本页确认树；分层理由见 [architecture.md](../architecture.md) v0.3、契约见 [modules/](../modules/) |

## 目的

把一件事钉死：**下面这棵叶子树就是已定文件模块架构。** 动工时按这棵树建目录，不要另起一套分层，也不要把 architecture 示例里较粗的文件名当成另一套树。

分层理由（契约前置、biz 与 service 分离、库操作走 data、不抄 macaron 在线层）仍以 architecture 为准；每个目录准做什么，以 [docs/modules/](../modules/) 为准。本文件锁树，不重写成 types 字段说明书。

## 读者

- 准备写 `src/` 的人：先看这棵树和「禁止另开」名单。
- 读文档的人：分清 architecture（为什么这样切）、modules（这个目录的契约）、本文件（文件落哪、树锁没锁）。

## 已定结论

1. **叶子树已定。** 下节那棵树是开工对照。architecture v0.3 的分层纪律有效；示例里的 `types/trace.ts`、`service/report.ts`、`label_enum.ts` 等被本树取代，不要两套并行。
2. **不另开** `src/gateway/`、`src/runtime/`、`src/biz/`。接入门面仍是 `adapters/`（产品名「Agent Gateway」不是目录名）。编排不是 runtime agent。macaron 的 `biz/` 对应到这里是 `pipeline/` + `agent/`，不要再套一层 `biz/`。
3. **不抄 macaron 在线层。** 参考的是纪律：契约前置、每 enum 一文件、biz 不碰库、service 薄壳、bun 装依赖 / node 跑产物、不要 `package-lock.json`。不抄 `remote/`、`middleware/`、`decorator/`、`observability/`、在线服务那套。
4. **`createAgentSession` 只允许出现在 `src/agent/sessions/`。** 见 [pi-sdk.md](./pi-sdk.md)。
5. **`service/live.ts` 只读订阅 Distiller 自己的裁剪进度，不进 pipeline。** live ≠ 盯对方 coding agent。蒸馏主链路仍离线。与 [users-and-surfaces.md](./users-and-surfaces.md) / 058e32e 收口一致。
6. **工程骨架：`bun install`，`node` 跑产物。** 锁文件只用 bun lock；不要 `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`。
7. **「树已定」≠「字段已拍板」。** P0 结构体不定，segmenter / rules / 卡片流不能并行开工——这是 [TODO.md](../TODO.md) 的硬前置。

一句话：

> 树锁了；契约文档在 modules；JSON 字段和工程骨架还没锁。读本页看文件落哪，读 architecture 看为什么，读 TODO P0 看还能不能动工。

## 已定文件树

```text
trace-distiller/
├─ AGENTS.md
├─ package.json                 # bun 装依赖；scripts 用 node 跑产物
├─ bun.lock                     # 唯一锁文件；不要 package-lock.json
├─ tsconfig.json / tsconfig.build.json / eslint.config.js
├─ script/
│  ├─ run-distill.ts            # 进程入口（启动时加载本机 .env）
│  └─ smoke-mint.ts             # 可选：有 key 时对 mint 打一条短 prompt
├─ src/
│  ├─ types/
│  │  ├─ raw_trace.ts
│  │  ├─ agent_view.ts
│  │  ├─ segment.ts
│  │  ├─ cut_plan.ts
│  │  ├─ cut_warrant.ts
│  │  └─ cut_profile.ts
│  ├─ enums/                    # 每 enum 一文件，不要塞回 enums.ts
│  │  ├─ label.ts
│  │  ├─ scenario.ts
│  │  ├─ agent_role.ts
│  │  ├─ focus.ts
│  │  └─ cut_action.ts
│  ├─ constant/
│  │  ├─ compression.ts
│  │  ├─ window.ts
│  │  └─ skill_route.ts
│  ├─ domain/
│  │  ├─ label_decision.ts
│  │  ├─ cut_decision.ts
│  │  └─ span_violation.ts
│  ├─ adapters/
│  │  └─ claude_code.ts         # M1；openclaw 同构复用此 parser，不另开 TraceSource
│  ├─ pipeline/                 # 对应 macaron biz，不要再开 src/biz/
│  │  ├─ segmenter.ts
│  │  ├─ rules.ts
│  │  ├─ orchestrator.ts
│  │  ├─ assembler.ts
│  │  └─ tools_only.ts          # ADR-0013 tools-only RawTurn 过滤（无 IO、不进洞）
│  ├─ agent/
│  │  ├─ sessions/              # 全仓库唯一可 import pi（含 tool_mask.ts）
│  │  │  ├─ open_session.ts      # 工厂 + SessionBackend；createAgentSession 只在这里
│  │  │  ├─ card_index.ts       # CARD_INDEX 紧凑序列化（洞 A/B 共用）
│  │  │  ├─ candidate_pool.ts   # ADR-0011 分层候选池
│  │  │  ├─ sparse_intent.ts    # ADR-0011 多轮稀疏采样（洞 A）
│  │  │  ├─ skeleton_pass.ts    # 洞 A 入口 → sparseIntent；兼容旧类型
│  │  │  ├─ cut_brain.ts        # ADR-0012 单槽 + 渐进披露；洞 B 角色
│  │  │  ├─ cut_brain_harness.ts # S0–S3 / evidence card / keep bits
│  │  │  ├─ label_window.ts
│  │  │  ├─ write_warrant.ts    # 可改纯代码，形状不变
│  │  │  ├─ l4_qa.ts            # runQa；role=l4_qa
│  │  │  ├─ l4_replay.ts        # runReplay；干净会话，不代理原工具历史
│  │  │  └─ l4_review.ts        # runBlindReview；禁止 warrant/skeleton
│  │  ├─ extension.ts
│  │  └─ skills/
│  ├─ data/                     # SQLite；biz 不直接碰库
│  │  ├─ data_segment.ts
│  │  ├─ data_label.ts
│  │  ├─ data_warrant.ts
│  │  └─ data_metric.ts
│  ├─ eval/                     # L4 数字 + 分档报分壳（benchmark.ts）+ Hole A 向量效率（vector_efficiency.ts，bench-only）；干净会话走 sessions 工厂
│  ├─ service/
│  │  ├─ cli.ts
│  │  ├─ export_utility.ts      # ADR-0013 四臂 TrainingCut 导出脚手架
│  │  ├─ live.ts                # 只读订阅，不进 pipeline；进程内 job 表
│  │  └─ live_socket.ts         # 可选 Unix domain socket；禁止 HTTP / TCP 端口
│  ├─ report/                   # 结果 JSON → 自包含 HTML；不要再开 service/report.ts
│  │  ├─ html.ts                # Playback 报告
│  │  └─ live_page.ts           # 只读 live dump 页（file://）
│  └─ utils/                    # 仅无状态：token 估算、jsonl、logger、.env 加载
├─ tests/
├─ examples/
├─ data/                        # 运行时原料与产物（真实数据默认 gitignore）
├─ benchmark/
└─ docs/
```

SWE-bench / pi-session 的 adapter **类型可预留**，MVP **不写 parser 文件**，不要为此插队加 `src/adapters/swebench.ts`。见 [ingest-and-preprocess.md](./ingest-and-preprocess.md)、[datasets.md](./datasets.md)。

以后若必须再加 enum（例如 `TraceSource`），继续「每 enum 一文件」，禁止合并进已有五个文件。

## 怎么用 / 怎么跑

代码尚未开始（`src/` 为空，没有 `package.json`）。「跑」在这一层是指：**按树读、按树建、按表知道什么能写。**

### 怎么读

| 你想知道 | 去哪 | 不要去哪 |
|----------|------|----------|
| 为什么是流水线不是一个 agent | [architecture.md](../architecture.md) | 本文件（不重写分层理由） |
| 某个目录准做什么 | [docs/modules/](../modules/) 对应篇 | 把本树当字段说明书 |
| 文件叫什么、落哪 | **本页树** | architecture 示例里较粗的文件名 |
| 洞 A/B 怎么嵌 | [agent-harness.md](./agent-harness.md) | 把 Distiller 理解成 runtime agent |
| pi 包到哪一层 | [pi-sdk.md](./pi-sdk.md) | orchestrator / eval / live 里直接 `createAgentSession` |
| live 页是什么 | [users-and-surfaces.md](./users-and-surfaces.md)、`service/live.ts` | `src/gateway/`、盯对方 agent |
| 什么还没拍板 | 下表 OPEN 行 + [TODO.md](../TODO.md) P0 | 把 modules 草图当已实现 |

落地顺序仍用 architecture：契约 → L0+L1+SQLite → 无洞保守导出 → 报告骨架 → 洞 A → 洞 B → assembler → eval。

### 按树开工

- 新文件必须落进已有叶子。禁止新建 `src/gateway/`、`src/runtime/`、`src/biz/`、`src/agents/`。
- 每个 enum 一个文件。上树五个是已定集合。
- `pipeline/` 与 `agent/` 不直接碰 SQLite；入口逻辑不写进 CLI；utils 只放无状态小函数。
- live 只挂订阅：不改编排、不进 orchestrator 热路径、不 import pi。
- 跳过洞的通路是一等公民：`--no-llm` 仍应能导出保守 CutPlan。
- 依赖：`bun install`；跑：`node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--report out.html]`（见 [script-run-distill.md](../modules/script-run-distill.md)）。现在不要创建 ts / lockfile。

### 已定 / 仍 OPEN

「已定」= 路径、文件名、分层纪律已锁，按这个建。「OPEN」= 契约草图有了，但 TODO P0 或 module 开放问题还没关，**不能当实现完成**。OPEN 一律链回 [TODO.md](../TODO.md)。

| 路径 | 职责（已定） | 状态 | OPEN 时去哪 |
|------|--------------|------|-------------|
| `src/types/*.ts`（六文件） | RawTrace / AgentView / Segment / CutPlan / CutWarrant / CutProfile | **文件名已定；字段 OPEN** | [TODO.md](../TODO.md) P0 结构体；草图 [types.md](../modules/types.md) |
| `src/enums/` 五文件 | Label / Scenario / AgentRole / Focus / CutAction | **文件集合已定** | Label / Focus / CutAction / AgentRole / **Scenario 五字面量已定**（[enums.md](../modules/enums.md)） |
| `src/constant/` 三文件 | 压缩率区间、窗口、skill 路由表 | **文件名已定；数字已拍板** | 见 [constant.md](../modules/constant.md) |
| `src/domain/` 三文件 | LabelDecision / CutDecision / SpanViolation | **文件名已定** | 不变量跟 types 一起钉 |
| `src/adapters/claude_code.ts` | L0 解析 + Admission Gate | **M1 文件已定** | 启发式阈值见 ingest 开放问题；SWE-bench parser MVP 不做 |
| `src/pipeline/*.ts` 五文件 | 切段 / 规则 / 编排 / 组装 / tools-only 过滤 | **文件名已定** | Jaccard / span 数字已拍板；`writeWarrant` 已改纯代码；`tools_only.ts` 是 ADR-0013 对照臂纯函数 |
| `src/agent/sessions/` | **唯一 pi 依赖点** | **文件名已定** | `open_session.ts` 工厂；`tool_mask.ts` / `cut_brain.ts`（ADR-0010）；洞 A/B；`write_warrant.ts`；L4 |
| `src/agent/extension.ts` / `skills/` | 洞内工具 + 分场景 Markdown | **路径已定** | LOCKED：`label_segment` / `check_continuity` / `keep_segment` / `read_segment` / `apply_rules_hint`（[tools.md](./tools.md)） |
| `src/data/data_*.ts` 四文件 | SQLite：段 / 打标 / 凭证 / 指标 | **文件名已定** | **列级 schema OPEN**（P0） |
| `src/eval/` | L4 数字 + 分档报分（`benchmark.ts`）+ Hole A 向量效率（`vector_efficiency.ts`） | **职责已定** | 盲测协议已拍板。QA/replay/review 经 sessions。`a_eff` 仅 bench，非在线停机。复合分见 [benchmark.md](./benchmark.md)；禁止跨赛道平均 |
| `src/report/` | 结果 JSON → 单个 `.html` | **已定** | 视觉细节非契约 |
| `src/service/cli.ts` | CLI 薄壳 | **已定** | argv 细节 OPEN |
| `src/service/export_utility.ts` | ADR-0013 四臂 TrainingCut 导出 | **已定** | 仍非 SFT；human_curated v0 可 stub |
| `src/service/live.ts` | 只读订阅 Distiller 裁剪进度 | **已定** | 源 = 进程内 `registerJobFromResult`；禁止 HTTP listen；禁止进 pipeline |
| `src/service/live_socket.ts` | 可选 Unix domain socket 传输 | **已定** | 默认关闭；JSON lines 调 live 六工具；禁止 HTTP / TCP 端口；不替代进程内表 |
| `src/utils/` | token 估算、jsonl、logger | **已定** | 计数库选型未锁（口径已在 ingest 收口） |
| `script/run-distill.ts` | 进程入口 | **已定** | 仓库还没有 package.json |
| 锁文件 / 运行时 | bun 装、node 跑、不要 npm lock | **已定** | 工程骨架仍 OPEN（P0） |

architecture 三条活口也已定：**目录不用为它们预留第四种形状**。内核可换只经 `agent/sessions/`。

## 边界（非目标）

- 不重写 architecture，不在这里展开 L0–L4 的算法。
- 不把 modules 的字段草图再抄一遍。
- 不把 OPEN 项「确认」成字段已拍板。
- **不另开** `src/gateway/`、`src/runtime/`、`src/biz/`。Gateway 产品名落 `adapters/`；live 落 `service/live.ts`。
- 不抄 macaron 的 remote / middleware / observability。
- 不在确认书里再改树。以后要改目录，先改本页（并同步 architecture / ADR），不要在 PR 里默默加顶层目录。
- 不把 distill 编排交给 pi agent loop（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。

## 开放问题

本页不再把「文件叫什么」列为 OPEN。仍挡开工的是：

1. **AgentView / SegmentCard / CutWarrant / CutProfile 字段**（P0 结构体）。树等它们，不是反过来。
2. **注意力默认档、token 计数库选型**（P0 / ingest 实现细节）。口径与切段默认已在 ingest 收口。
3. **工程骨架**：AGENTS.md、package.json、tsconfig、eslint、pi spike、SQLite 列级 schema。
4. **Scenario 名单**与 `SKILL_ROUTE` 已拍板；洞 A 仍未接通，不要把 skill 文件当成 M2 完成。
5. **蒸馏洞三个工具**已拍板闭集，不在本页发明第四个判断力工具。

## 完成标准

- [x] 具体叶子树写成已定文件模块架构（含 types 六文件、enums 五文件、sessions 四文件、data 四文件、`service/live.ts`）。
- [x] 明确禁止 `src/gateway/`、`src/runtime/`、`src/biz/`。
- [x] bun 装 / node 跑 / 不要 `package-lock.json` 写进工程约定。
- [x] 每个 `src/` 叶子都能链到一篇 module 契约。
- [ ] P0 结构体与工程骨架关闭后，把本表 OPEN 行改成「已定」或另开 ADR，而不是在 PR 里默默加目录。
- [ ] `src/` 开工后，顶层目录与本树一致（目录快照或 code review 对照）。

## 相关文档

- [architecture.md](../architecture.md) v0.3 — 分层理由
- [modules/README.md](../modules/README.md) — 工程契约
- [pi-sdk.md](./pi-sdk.md) / [agent-harness.md](./agent-harness.md)
- [users-and-surfaces.md](./users-and-surfaces.md) — live 定义
- [TODO.md](../TODO.md)
