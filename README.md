# Trace Distiller（Trace 精华剪辑器）

> Agent 一次任务可能留下几百步记录。本工具只处理「最终做对了」的那条，把它剪短：训练能用，人也能看懂。

**当前状态**：TypeScript 流水线 + 两个 agent 洞。无洞（`--no-llm`）与假后端带洞两条通路可跑；自包含 HTML 报告；SQLite 记段 / 打标 / 凭证 / 指标；只读 live dump 页（`file://`，进程内 job 表）。可选本机 Unix domain socket（`--live-socket`，默认关闭）。真模型 L4 重放/QA **尚未接通**。

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

## 怎么跑

入口：

```text
node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--sqlite path] [--out-dir dir] [--report out.html] [--live-dump dir] [--live-socket path] [--no-llm]
node script/run-distill.ts eval <trace_id> --sqlite path
node script/run-distill.ts report <trace_id> --sqlite path --out out.html
node script/run-distill.ts live-dump --sqlite path [--out-dir dir] [trace_id]
node script/run-distill.ts bench [--dir benchmark/datasets]
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

`eval` 读压缩率、规则覆盖、LLM 段占比、Fail-Closed 数。`replay` / QA **不会跑**：需要真模型 L4（`TRACE_DISTILLER_MODEL_L4`），不要把空壳当成已接通。

`bench` 扫 `benchmark/datasets/{short,long,multi_dead_end}`，stdout 打 JSON 分档表。三档禁止合并平均。无金标则召回 skipped（M1 不硬挂）。M1 不强求满数据集。

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

设置洞模型后再跑，不要加 `--no-llm`：

```bash
export TRACE_DISTILLER_MODEL_HOLE_A=…   # 洞 A 骨架
export TRACE_DISTILLER_MODEL_HOLE_B=…   # 洞 B 逐窗打标
# 可选：TRACE_DISTILLER_MODEL_L4=…     # 盲测/QA/重放；尚未接通
node script/run-distill.ts distill examples/add-fix.jsonl --sqlite /tmp/distiller.sqlite --report /tmp/holes.html
```

未设上述 env、也没有注入 session 后端时，自动走无洞。

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
