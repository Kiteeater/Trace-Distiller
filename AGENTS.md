# Trace Distiller — 工程规则

给写代码的人（和 agent）看。产品词以 [CONTEXT.md](./CONTEXT.md) 为准；分层理由见 [docs/architecture.md](./docs/architecture.md)；叶子文件以 [docs/guides/file-architecture.md](./docs/guides/file-architecture.md) 为准。

## 这不是一个 agent

编排是纯 TypeScript 流水线。LLM 只出现在洞 A（骨架）、洞 B（逐窗打标）和 L4 eval 干净会话（QA / replay / review）。L4 不计蒸馏成本。不要把 Distiller 理解成 runtime agent，不要引入 LangChain 一类编排框架。

## 命令

- 装依赖：`bun install`（唯一锁文件 `bun.lock`）
- 跑产物：`node`（不要用 bun 当运行时跑产物）
- 类型检查：`bun run typecheck` 或 `tsc --noEmit`
- **不要**提交 `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`

入口：

```text
node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--report out.html] [--live-dump dir] [--live-socket path] [--no-llm]
node script/run-distill.ts eval <trace_id> --sqlite path [--qa] [--replay]
node script/run-distill.ts report <trace_id> --sqlite path --out out.html
node script/run-distill.ts live-dump --sqlite path [--out-dir dir] [trace_id]
node script/run-distill.ts bench [--dir benchmark/datasets] [--no-llm] [--fake-l4] [--with-l4]
```

`--no-llm` 强制无洞；未加且注入了假后端或设了洞模型 env 时走 `with_llm`。`eval` 读 SQLite 蒸馏指标；`--qa` / `--replay` 在有会话后端（注入 FakeSessionBackend 或 `TRACE_DISTILLER_MODEL_L4`）时跑 L4，否则跳过并注明。真实重放成功率需要仓库+模型，CI 只保证接口。`bench` 默认 `no_llm`（防 mint 挂起）；`--fake-l4` 打本地 composite；`--with-l4` 才连真 mint（会话硬超时）。扫 `short` / `long` / `multi_dead_end` 分档报 JSON，禁止合并平均；无金标则召回 skipped；六项有 fail 则该样本总分 0。pi 工厂 spike：`bun run pi-spike`。

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
- `Scenario` 已拍板：`debug` | `implement` | `refactor` | `test_fix` | `investigate`。`SKILL_ROUTE` 指向 `agent/skills/{name}.md`；查不到回退 `implement`，禁止静默空 prompt。
- 窗口 / span / Jaccard / head / 死胡同条数已拍板：`LABEL_WINDOW_SIZE=8`、`SPAN_MAX_GAP_SEGMENTS=3`、`SIMILAR_RETRY_TOKEN_JACCARD_THRESHOLD=0.8`、`SEGMENT_HEAD_MAX_CHARS=120`、`DEAD_END_MAX_REPRESENTATIVE=3`、`DEAD_END_SUMMARY_MAX_CHARS=80`。`DEFAULT_CUT_PROFILE` 用这些数。禁止在 pipeline 另写魔数。
- 卡片字段由代码填，禁止 LLM 生成 `head` / `sig` / `focus`。segmenter 截 `head` 到 `SEGMENT_HEAD_MAX_CHARS`。
- L0：`src/adapters/claude_code.ts` 解析单任务 claude-code JSONL 并执行 Admission Gate。
- L1：切段 / 规则打标 / 无洞编排 / assembler / SQLite / 自包含报告 / distill CLI 已通。
- **无洞通路**：`distill({ mode: 'no_llm' })` 与 CLI `--no-llm`。规则已决议按 CutProfile 裁；未决段 Fail-Closed Keep。凭证走 `src/agent/sessions/write_warrant.ts` 纯代码汇总（LabelDecision[] + 未决 keep + decideCut），orchestrator 可复用。
- **带洞通路**：`distill({ mode: 'with_llm', opts: { sessionBackend } })`。洞 A `skeletonPass` 写回 intent/skeleton；未决按 `LABEL_WINDOW_SIZE` 串行 `labelWindow`（skill 经 `resolveSkillRoute`）；`still_unlabeled` ∪ 窗失败 Fail-Closed Keep（source.name=`fail_closed_keep`）；合并规则+LLM decisions → writeWarrant → assemble。盲测用 `eval.review` 纯代码对照骨架与 plan，缺节点回填 keep，最多 `REVIEW_MAX_ROUNDS`，不调 L4 LLM。测试注入 `FakeSessionBackend`。
- Live：`src/service/live.ts` 内存订阅 Distiller job（`list_jobs` / `attach_job` / `detach_job` / `get_cut_progress` / `get_partial_result` / `get_warrant_tail`）+ 只读 `dumpJobSnapshot` / `dumpAllJobs`。纯 TS，无 LLM。源 = 进程内 `registerJobFromResult`，禁止 HTTP listen。可选 Unix domain socket 见 `src/service/live_socket.ts`（`startLiveSocket` / `stopLiveSocket`；CLI `--live-socket <path>`；默认关闭；JSON lines；distill 结束即关并 unlink，不 keep-alive）。默认传输仍是进程内表 + `--live-dump` / `live-dump` 写出 `<job_id>.live.json` 与 `file://` 自包含 `live.html`（`src/report/live_page.ts`）。页只读 Distiller 裁剪过程，不是对方 agent。`src/agent/skills/` 五份极简 Markdown + README；`src/utils/logger.ts` 无状态打 stderr。
- Eval：`compressionRatio` / `distillCostRatio` / `compressionScore` / `keyStepRecall` / `compositeScore` 纯函数（L4 token 不计蒸馏成本；`hole_a_plus_b_tokens` 优先读 pi-ai `Usage.input`/`output`，缺用量才 `estimateTokens`）；`computeDistillMetrics` 汇总压缩率、规则覆盖、LLM 段占比、Fail-Closed 数。蒸馏成功写入 `data` 指标表。分档报分壳：`src/eval/benchmark.ts`（`scoreSample` / `aggregateBins`）；召回只读独立金标，不读 LabelDecision。盲测协议：review 输入只有 intent + playback；缺骨架节点由代码回填 keep；最多 `REVIEW_MAX_ROUNDS=2`。L4 会话：`runQa` / `runReplay` / `runBlindReview`（`src/agent/sessions/l4_*.ts`）；eval 调用这些函数。假后端返回可解析 QA/replay/review JSON；真模型走 `TRACE_DISTILLER_MODEL_L4`。编排器不 import L4。
- 蒸馏洞三工具已拍板闭集：`label_segment` / `check_continuity` / `read_segment`。`src/agent/extension.ts` 纯函数 handler（校验枚举 / 取数）；rationale 不进凭证；`read_segment` 只本段；一窗一会话；Fail-Closed Keep。handler 不接 pi。
- 洞 A `skeletonPass`、洞 B `labelWindow`、衔接 `checkContinuityPair` 已接通：只经 `openSession`。假后端 `FakeSessionBackend` 可测稳定 JSON / `tool_calls`；真模型需 `TRACE_DISTILLER_MODEL_HOLE_A` / `TRACE_DISTILLER_MODEL_HOLE_B`。洞 A 只注入头/验证点原文 + 卡片索引，禁止全量 `raw.turns`。洞 B 一窗一会话，未调 `label_segment` 的 id 不瞎标。orchestrator `with_llm` 已串这两洞；本文件仍禁止 `import` pi / `createAgentSession`。

## 仍未接通（禁止假装完成）

- 真模型 L4 重放成功率：接口已接通（假后端可测；真模型 `TRACE_DISTILLER_MODEL_L4`）。真实重放仍需仓库 + 模型，CI 不假装测到成功率。`distill({ mode: 'with_llm' })` 盲测回填仍只用纯代码对照骨架与 plan，不调 L4。
- Unix socket 已接通（可选）：默认仍进程内 `registerJobFromResult` + `file://` dump；`--live-socket` 另开只读窗。live 仍禁止 HTTP listen。
- pi SDK / `createAgentSession`：只允许出现在 `src/agent/sessions/`（现为 `open_session.ts`）。eval 干净会话必须走该目录的工厂。模型档走环境变量 `TRACE_DISTILLER_MODEL_HOLE_A` / `TRACE_DISTILLER_MODEL_HOLE_B` / `TRACE_DISTILLER_MODEL_L4`（`provider/modelId`）。OpenAI-compatible 自定义网关（Macaron mint）：`TRACE_DISTILLER_API_BASE` + `TRACE_DISTILLER_API_KEY`（`TRACE_DISTILLER_PROVIDER` 默认 `macaron`）；`PiSessionBackend` 对此 `registerProvider`（`api: openai-completions`）再用 `registry.find`，不走内置 `getModel`。CLI 入口加载本机 `.env`（若存在）。密钥不进代码、不进 git、不 log。失败重试 1 次（`PI_FAILURE_RETRY`）再 Fail-Closed。生产默认 `PiSessionBackend`；`FakeSessionBackend` 仅测试。

## TypeScript

- `strict` 打开。类型从 enums 引用，不要在 types 里另写一套同义字面量。
- 新文件必须落进 [已定叶子树](./docs/guides/file-architecture.md)。改目录先改那一页。
