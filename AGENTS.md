# Trace Distiller — 工程规则

给写代码的人（和 agent）看。产品词以 [CONTEXT.md](./CONTEXT.md) 为准；分层理由见 [docs/architecture.md](./docs/architecture.md)；叶子文件以 [docs/guides/file-architecture.md](./docs/guides/file-architecture.md) 为准。

## 这不是一个 agent

编排是纯 TypeScript 流水线。LLM 只出现在洞 A（骨架）和洞 B（逐窗打标）。不要把 Distiller 理解成 runtime agent，不要引入 LangChain 一类编排框架。

## 命令

- 装依赖：`bun install`（唯一锁文件 `bun.lock`）
- 跑产物：`node`（不要用 bun 当运行时跑产物）
- 类型检查：`bun run typecheck` 或 `tsc --noEmit`
- **不要**提交 `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`

当前契约层还没有 CLI。以后入口是 `node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--report out.html]`。

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
- L0：`src/adapters/claude_code.ts` 解析单任务 claude-code JSONL 并执行 Admission Gate。不要写 `pipeline/`、pi 会话、SQLite。

## TypeScript

- `strict` 打开。类型从 enums 引用，不要在 types 里另写一套同义字面量。
- 新文件必须落进 [已定叶子树](./docs/guides/file-architecture.md)。改目录先改那一页。
