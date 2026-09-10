# Trace Distiller（Trace 精华剪辑器）

> Agent 一次任务可能留下几百步记录。本工具只处理「最终做对了」的那条，把它剪短：训练能用，人也能看懂。

**当前状态**：TypeScript 流水线 + 两个 agent 洞。无洞（`--no-llm`）与假后端带洞两条通路可跑；自包含 HTML 报告；SQLite 记段 / 打标 / 凭证 / 指标；只读 live dump 页（`file://`，进程内 job 表）。可选本机 Unix domain socket（`--live-socket`，默认关闭）。L4 接口已接通：`--fake-l4` 可本地打出 composite>0；真 mint 用 `--with-l4`（会话有硬超时）。

编排是纯 TypeScript 流水线，不是 runtime agent。LLM 只出现在洞 A（骨架）和洞 B（逐窗打标）。分层见 [docs/architecture.md](./docs/architecture.md)。

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

# 1) 无洞蒸馏示例
node script/run-distill.ts distill examples/add-fix.jsonl \
  --no-llm \
  --sqlite /tmp/distiller.sqlite \
  --report /tmp/add-fix.report.html \
  --live-dump /tmp/distiller-live
# 打开 /tmp/distiller-live/live.html

# 2) 分档记分板（默认 no_llm，有 mint .env 也不会挂）
node script/run-distill.ts bench --no-llm --fake-l4
# → stdout JSON + benchmark/out/scoreboard.md
```

**composite（复合分）是什么？** 六项门槛全过才算分，否则该样本为 `0`；有 skipped 且无 fail → `null`。算分：`压缩率得分 × 关键步召回 × 重放成功率`（乘法，堵「全删 / 全留」）。三档 `short` / `long` / `multi_dead_end` **分开报，禁止合成平均**。

**mint 环境变量（写在 gitignored `.env`，不要提交密钥）：**

```bash
cp .env.example .env
# TRACE_DISTILLER_API_BASE=https://mint-alpha.macaron.im/v1
# TRACE_DISTILLER_API_KEY=          # 仅本机
# TRACE_DISTILLER_PROVIDER=macaron
# TRACE_DISTILLER_MODEL_HOLE_A=macaron/macaron-v1-coding-venti
# TRACE_DISTILLER_MODEL_HOLE_B=macaron/macaron-v1-coding-venti
# TRACE_DISTILLER_MODEL_L4=macaron/macaron-v1-coding-venti
# 可选：TRACE_DISTILLER_SESSION_TIMEOUT_MS=120000
```

真 mint L4（opt-in，防挂）：`bench --with-l4`。日常 CI / 过夜用 `bench --no-llm --fake-l4`。


---

## 怎么跑

入口：

```text
node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--out-dir dir] [--report out.html] [--live-dump dir] [--live-socket path] [--no-llm]
node script/run-distill.ts eval <trace_id> --sqlite path
node script/run-distill.ts report <trace_id> --sqlite path --out out.html
node script/run-distill.ts live-dump --sqlite path [--out-dir dir] [trace_id]
node script/run-distill.ts bench [--dir benchmark/datasets] [--no-llm] [--fake-l4] [--with-l4]
```

`package.json` 里也可以：`bun run distill -- distill …`（仍是 node 跑 `script/run-distill.ts`）。

### 无洞（演示默认）

不调模型。规则已决议按 CutProfile 裁；未决段 Fail-Closed Keep。

```bash
node script/run-distill.ts distill examples/add-fix.jsonl \
  --no-llm \
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

`bench` 默认 `no_llm`（即使有 mint env 也不挂）。`--fake-l4` 走假后端打分；`--with-l4` 才启用真 mint。扫 `benchmark/datasets/{short,long,multi_dead_end}`，stdout 打 JSON 分档表。三档禁止合并平均。无金标则召回 skipped（M1 不硬挂）。

### 只读 live 页（Distiller 裁剪，不是对方 agent）

蒸馏成功后 dump 进程内 job 快照，双击 `file://` 打开。默认传输是进程内 `registerJobFromResult` + 这份 dump。禁止 HTTP listen。

```bash
node script/run-distill.ts distill examples/add-fix.jsonl \
  --no-llm \
  --live-dump /tmp/distiller-live
# 打开 /tmp/distiller-live/live.html
node script/run-distill.ts live-dump --sqlite /tmp/distiller.sqlite --out-dir /tmp/distiller-live
```

可选：`--live-socket /tmp/distiller.live.sock` 在 distill **期间**听 Unix domain socket（JSON lines：`{"op":"list_jobs"}` 等，回 live 六工具结果）。默认关闭。命令结束会 `stopLiveSocket` 并删除 sock 文件，进程不 keep-alive。事后复盘仍用 `--live-dump`。不是 TCP 端口，不是 HTTP。

### 带洞（真模型）

设置洞模型后再跑，不要加 `--no-llm`。`node script/run-distill.ts` 启动时会加载本机 `.env`（若存在）；不要提交 `.env`。

接 Macaron mint（OpenAI-compatible 网关）：复制 `.env.example` 为 `.env`，填 `TRACE_DISTILLER_API_KEY`。`PiSessionBackend` 在 `API_BASE`+`API_KEY` 都设时 `registerProvider`，不走内置 `getModel`。密钥永不打进日志。

```bash
# .env（gitignored）
# TRACE_DISTILLER_API_BASE=https://mint-alpha.macaron.im/v1
# TRACE_DISTILLER_API_KEY=          # 不要把密钥写进仓库
# TRACE_DISTILLER_PROVIDER=macaron  # 默认 macaron
export TRACE_DISTILLER_MODEL_HOLE_A=macaron/macaron-v1-coding-venti
export TRACE_DISTILLER_MODEL_HOLE_B=macaron/macaron-v1-coding-venti
# 可选：TRACE_DISTILLER_MODEL_L4=macaron/macaron-v1-coding-venti
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
- [docs/architecture.md](./docs/architecture.md) — 流水线 + 两个 agent 洞
- [docs/modules/](./docs/modules/) — 模块契约
- [AGENTS.md](./AGENTS.md) — 工程规则（给写代码的人）
- [docs/TODO.md](./docs/TODO.md) — 执行队列
- [docs/adr/](./docs/adr/) — 已拍板的决定
- [PRD.md](./PRD.md) — 需求草案
- [benchmark/README.md](./benchmark/README.md) — 复合分与防作弊
