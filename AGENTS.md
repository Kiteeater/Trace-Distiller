# Trace Distiller — 工程规则

给写代码的人（和 agent）看。产品词以 [CONTEXT.md](./CONTEXT.md) 为准；分层理由见 [docs/architecture.md](./docs/architecture.md)；叶子文件以 [docs/guides/file-architecture.md](./docs/guides/file-architecture.md) 为准。

## 这不是一个 agent

编排是纯 TypeScript 流水线。LLM 只出现在洞 A（骨架）和洞 B（逐窗打标）。不要把 Distiller 理解成 runtime agent，不要引入 LangChain 一类编排框架。

## 命令

- 装依赖：`bun install`（唯一锁文件 `bun.lock`）
- 跑产物：`node`（不要用 bun 当运行时跑产物）
- 类型检查：`bun run typecheck` 或 `tsc --noEmit`
- **不要**提交 `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`

入口：`node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--report out.html] [--no-llm]`。默认无洞通路。

## 分层纪律

1. **契约前置**：`src/types` / `src/enums` / `src/constant` 先于一切实现。字段未拍板的标 `// OPEN:`，禁止在 pipeline 里另写魔数。
2. **biz 纯逻辑**：`pipeline/` 与 `agent/` 不碰 IO 入口，不直接碰库。
3. **service 薄壳**：CLI 只解析参数、调流水线、写退出码。步骤顺序不写在 CLI 里。
4. **data 统一管库**：SQLite 只出现在 `src/data/`。
5. **utils 无状态**：有状态的进 `domain/` 或 `data/`。
6. **pi 只经 sessions**：全仓库唯一可 `import` pi / 调用 `createAgentSession` 的地方是 `src/agent/sessions/`。`eval/` 起干净会话也必须走该目录的工厂。

## 禁止另开

不要新建 `src/gateway/`、`src/runtime/`、`src/biz/`、`src/agents/`。接入门面是 `adapters/`；macaron 的 `biz/` 在这里是 `pipeline/` + `agent/`。

每个 enum 一个文件。已定五个：`label` / `scenario` / `agent_role` / `focus` / `cut_action`。以后若加（例如 `TraceSource`），继续新文件，禁止塞回已有文件。

## 契约层约定（当前已落地）

- 一条 `RawTrace` = 一个任务；`ground_truth` 必填。Admission 三码：`no_ground_truth` / `unparseable` / `multi_task_ambiguous`。
- `Scenario` 名单未拍板，类型是 `unknown`。不要假装已有 skill 路由或场景码。
- 窗口大小、span 段数、Jaccard 阈值是命名常量，标注 `OPEN`，未拍板前不得当实现阈值。
- 卡片字段由代码填，禁止 LLM 生成 `head` / `sig` / `focus`。
- L0：`src/adapters/claude_code.ts` 解析单任务 claude-code JSONL 并执行 Admission Gate。
- L1：切段 / 规则打标 / 无洞编排 / assembler / SQLite / 自包含报告 / distill CLI 已通。
- **无洞通路**：`distill({ mode: 'no_llm' })` 与 CLI `--no-llm`。规则已决议按 CutProfile 裁；未决段 Fail-Closed Keep。凭证走 `src/agent/sessions/write_warrant.ts` 纯代码汇总（LabelDecision[] + 未决 keep + decideCut），orchestrator 可复用。
- Live：`src/service/live.ts` 内存订阅 Distiller job（`list_jobs` / `attach_job` / `detach_job` / `get_cut_progress` / `get_partial_result` / `get_warrant_tail`）。纯 TS，无 LLM。
- Eval：`compressionRatio` / `distillCostRatio` 纯函数（L4 token 不计蒸馏成本）。

## 仍未接通（禁止假装完成）

- 洞 A `skeletonPass`、洞 B `labelWindow`、衔接 `checkContinuityPair`：签名已导出，内部抛 `NotImplementedError`，待 pi spike。禁止假造 LLM 结果。orchestrator 不要接通这两洞。
- 蒸馏洞三工具（`label_segment` / `check_continuity` / `read_segment`）：`src/agent/extension.ts` 只导出 DRAFT 名单，稍后拍板，无执行体。
- pi SDK / `createAgentSession`：全仓库不得真正 import；仅 `src/agent/sessions/` 可留 `// TODO createAgentSession` 注释。eval 干净会话必须走 sessions 工厂（同样 NotImplemented）。
- live 传输细节（进程内事件 / 本机 socket / 临时端口）OPEN；禁止 HTTP listen。
- OPEN 数字阈值（窗口大小、死胡同条数、Jaccard 正式拍板等）与盲测判分协议。

## TypeScript

- `strict` 打开。类型从 enums 引用，不要在 types 里另写一套同义字面量。
- 新文件必须落进 [已定叶子树](./docs/guides/file-architecture.md)。改目录先改那一页。
