# Trace Distiller（Trace 精华剪辑器）

> Agent 一次任务可能留下几百步记录。本工具只处理「最终做对了」的那条，把它剪短：训练能用，人也能看懂。

**当前状态**：Agent 主编裁剪 + 确定性护栏（[ADR-0010](./docs/adr/0010-agent-led-cut-with-tool-mask.md)）；洞 B 目标见 [ADR-0012](./docs/adr/0012-hole-b-single-slot-progressive-disclosure.md)（单槽 focus=1 + 渐进披露 + collapse_uncertain）。`--no-llm` 已删除；CI 用 `--fake-l4` / FakeSessionBackend。自包含 HTML 报告；SQLite 记段 / 打标 / 凭证 / 指标；只读 live dump 页（`file://`）。可选 Unix domain socket（`--live-socket`）。L4：`--fake-l4` 本地 composite；`--with-l4` 真 mint。

Agent session 决定 how to cut；admission / span / warrant / I/O 仍是确定性 TypeScript。工具结果经 tool mask 回灌。分层见 [docs/architecture.md](./docs/architecture.md)。

---

## 怎么装

依赖用 bun，产物用 node（不要用 bun 当运行时跑 CLI）。

```bash
bun install
bun run typecheck
bun run test
```

不要提交 `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`。锁文件只有 `bun.lock`。

---

## 一夜可跑通的路径（推荐）

按顺序跑，不碰密钥正文：

```bash
bun install
bun run typecheck
bun run test

# 1) 无洞蒸馏示例（或：bun run distill:example）
node script/run-distill.ts distill examples/add-fix.jsonl \
  --fake-l4 \
  --sqlite /tmp/distiller.sqlite \
  --report /tmp/add-fix.report.html \
  --live-dump /tmp/distiller-live
# 打开 /tmp/distiller-live/live.html

# 2) 分档记分板（默认 no_llm，有 mint .env 也不会挂）
node script/run-distill.ts bench --fake-l4
# 或：bun run bench:fake  /  bun run bench:m1
# → stdout JSON + benchmark/out/scoreboard.md
```

**composite（复合分）是什么？** 六项门槛全过才算分，否则该样本为 `0`；有 skipped 且无 fail → `null`。算分：`压缩率得分 × 关键步召回 × 重放成功率`（乘法，堵「全删 / 全留」）。三档 `short` / `long` / `multi_dead_end` **分开报，禁止合成平均**。

**m1_score（M1 出门分）**：只强制压缩率 + 关键步召回，`压缩率得分 × 关键步召回`。cost / replay / qa / coherence 失败不拖垮 `m1_score`（仍会拖垮 `composite`）。过夜真 mint 短 trace 常因 cost>0.3 使 composite=0；看 `m1_score` 判断 M1 是否成功。记分板有 `m1` 列。

**网关环境变量（写在 gitignored `.env`，不要提交密钥）。Mint/Macaron 是可选配置之一，不是内置默认：**

```bash
cp .env.example .env
# TRACE_DISTILLER_API_BASE=https://example.com/v1
# TRACE_DISTILLER_API_KEY=          # 仅本机
# TRACE_DISTILLER_PROVIDER=your-provider
# TRACE_DISTILLER_MODEL_HOLE_A=provider/modelId
# TRACE_DISTILLER_MODEL_HOLE_B=provider/modelId
# TRACE_DISTILLER_MODEL_L4=provider/modelId
# 可选：TRACE_DISTILLER_SESSION_TIMEOUT_MS=120000
# 长样 mint 建议：TRACE_DISTILLER_SESSION_TIMEOUT_MS=300000
```

真 mint L4（opt-in，防挂）：`bench --with-l4`。日常 CI / 过夜用 `bench --fake-l4`。


---

## 怎么跑

入口：

```text
node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--out-dir dir] [--report out.html] [--live-dump dir] [--live-socket path] [--fake-l4]
node script/run-distill.ts eval <trace_id> --sqlite path
node script/run-distill.ts report <trace_id> --sqlite path --out out.html
node script/run-distill.ts live-dump --sqlite path [--out-dir dir] [trace_id]
node script/run-distill.ts bench [--dir benchmark/datasets] [--fake-l4] [--with-l4]
```

`package.json` 快捷脚本：`bun run distill -- distill …`、`bun run distill:example`、`bun run bench:fake` / `bun run bench:m1`（仍是 node 跑 `script/run-distill.ts`）。

### 无洞（演示默认）

不调模型。规则已决议按 CutProfile 裁；未决段 Fail-Closed Keep。

```bash
node script/run-distill.ts distill examples/add-fix.jsonl \
  --fake-l4 \
  --sqlite /tmp/distiller.sqlite \
  --report /tmp/add-fix.report.html
```

小样与生成的示例 HTML 在 [examples/](./examples/)。

### 评测指标与从库出报告

```bash
node script/run-distill.ts eval <trace_id> --sqlite /tmp/distiller.sqlite
node script/run-distill.ts report <trace_id> --sqlite /tmp/distiller.sqlite --out /tmp/from-db.html
```

`eval` 读压缩率、规则覆盖、LLM 段占比、Fail-Closed 数。加 `--qa` / `--replay` 且设了 `TRACE_DISTILLER_MODEL_L4`（或注入假后端）才跑 L4；会话有硬超时。

`bench` 默认 `no_llm`（即使有 mint env 也不挂）。`--fake-l4` 走假后端打分；`--with-l4` 才启用真 mint。`--bin long` / `--bins short,long` 只跑所选赛道（短长阀门 CutProfile 不同）。扫 `benchmark/datasets/{short,long,multi_dead_end}`，stdout 打 JSON 分档表。三档禁止合并平均。无金标则召回 skipped（M1 不硬挂）。长 mint：`TRACE_DISTILLER_SESSION_TIMEOUT_MS=300000 bun run bench:long:mint`。

### 只读 live 页（Distiller 裁剪，不是对方 agent）

蒸馏成功后 dump 进程内 job 快照，双击 `file://` 打开。默认传输是进程内 `registerJobFromResult` + 这份 dump。禁止 HTTP listen。

```bash
node script/run-distill.ts distill examples/add-fix.jsonl \
  --fake-l4 \
  --live-dump /tmp/distiller-live
# 打开 /tmp/distiller-live/live.html
node script/run-distill.ts live-dump --sqlite /tmp/distiller.sqlite --out-dir /tmp/distiller-live
```

可选：`--live-socket /tmp/distiller.live.sock` 在 distill **期间**听 Unix domain socket（JSON lines：`{"op":"list_jobs"}` 等，回 live 六工具结果）。默认关闭。命令结束会 `stopLiveSocket` 并删除 sock 文件，进程不 keep-alive。事后复盘仍用 `--live-dump`。不是 TCP 端口，不是 HTTP。

### 带洞（真模型）

设置洞模型后再跑（或 `--fake-l4`）。`--no-llm` 已删除（ADR-0010）。`node script/run-distill.ts` 启动时会加载本机 `.env`（若存在）；不要提交 `.env`。

接 OpenAI-compatible 网关：复制 `.env.example` 为 `.env`，填 `TRACE_DISTILLER_API_KEY`。Mint/Macaron 是可选配置之一，不是内置默认。`PiSessionBackend` 在 `API_BASE`+`API_KEY` 都设时 `registerProvider`，不走内置 `getModel`。密钥永不打进日志。

```bash
# .env（gitignored）
# TRACE_DISTILLER_API_BASE=https://example.com/v1
# TRACE_DISTILLER_API_KEY=          # 不要把密钥写进仓库
# TRACE_DISTILLER_PROVIDER=your-provider
export TRACE_DISTILLER_MODEL_HOLE_A=provider/modelId
export TRACE_DISTILLER_MODEL_HOLE_B=provider/modelId
# 可选：TRACE_DISTILLER_MODEL_L4=provider/modelId
node script/run-distill.ts distill examples/add-fix.jsonl --sqlite /tmp/distiller.sqlite --report /tmp/holes.html
```

可选连通检查（无 key 则 skip）：`bun run smoke-mint`。

未设洞模型 env、也没有注入 session 后端时，自动走无洞。

### 假后端

`FakeSessionBackend` **只给测试用**（`tests/` 注入）。生产 CLI 不要用它冒充带洞通路。

---

## 它解决什么问题？

Agent 干成一件事，过程里往往有大量试错、重复读文件、确认环境之类的步骤。原始记录又长又脏：当训练数据又贵又噪；给人看要啃几百步。

```text
长且成功的原始记录  →  压缩后的精华版
（例如约 500 步）         （目标大约 30 步量级）
```

原料必须有「确实做对了」的证明（Ground Truth）。没有验证的、失败的记录一律不进。

---

## 文档

- [CONTEXT.md](./CONTEXT.md) — 产品用词
- [docs/guides/maturity.md](./docs/guides/maturity.md) — 绿/黄/红成熟度（什么能过夜跑、什么是 M2）
- [docs/architecture.md](./docs/architecture.md) — 流水线 + 两个 agent 洞
- [docs/modules/](./docs/modules/) — 模块契约
- [AGENTS.md](./AGENTS.md) — 工程规则（给写代码的人）
- [docs/TODO.md](./docs/TODO.md) — 执行队列
- [docs/adr/](./docs/adr/) — 已拍板的决定
- [PRD.md](./PRD.md) — 需求草案
- [benchmark/README.md](./benchmark/README.md) — 复合分与防作弊
