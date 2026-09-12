# Trace Distiller（Trace 精华剪辑器）

> 离线把**成功的** coding-agent traces 蒸馏成训练 / 回放用的精华剪辑。

Agent 一次任务可能留下几百步嘈杂记录。本工具只收有 Ground Truth 的成功轨迹，压短并保留关键决策：训练更省，人也好读。

## 怎么工作

```text
ingest → Hole A（稀疏 intent / skeleton）→ Hole B cut-brain（打标裁剪）→ warrant / assemble
                                                                    ↘ L4 eval（可选）
```

1. **Ingest**：解析成功 trace，过 Admission Gate  
2. **Hole A**：稀疏采样，抽出 intent 与骨架点  
3. **Hole B**：cut-brain 决定 keep / collapse / drop  
4. **Warrant / assemble**：落凭证，拼出训练 / 回放剪辑  
5. **L4**（可选）：QA / replay 等评测；日常可用 `--fake-l4`

Agent session 主编裁剪；admission / span / warrant / I/O 仍是确定性 TypeScript。

## 能干嘛

- 离线把 Claude Code / coding-agent 的成功 traces 压成更短剪辑
- warrant assemble 同时产出 Training Cut 与 Playback Cut
- Hole A 抽 intent/skeleton，Hole B 打标裁剪（回灌走 tool mask）
- Fake 或真 provider 跑 bench（m1 / L4 门禁）
- 任意 OpenAI-compatible 网关，env 配置即可，不绑某一家

## 快速开始

依赖用 **bun**，产物用 **node**（不要用 bun 跑 CLI）。

```bash
bun install
bun run typecheck
bun run test

# 蒸馏一个示例（假 L4）
bun run distill:example
# 等价：node script/run-distill.ts distill examples/add-fix.jsonl --fake-l4 \
#   --sqlite /tmp/distiller.sqlite --report /tmp/add-fix.report.html --live-dump /tmp/distiller-live

# 假后端分档 bench
bun run bench:fake
```

## 配置

复制 [`.env.example`](./.env.example) 为 `.env`（gitignored）。通用 OpenAI-compatible 网关，**不是**某家硬编码：

```bash
cp .env.example .env
# TRACE_DISTILLER_API_BASE=https://example.com/v1
# TRACE_DISTILLER_API_KEY=
# TRACE_DISTILLER_PROVIDER=your-provider
# TRACE_DISTILLER_MODEL_HOLE_A=provider/modelId
# TRACE_DISTILLER_MODEL_HOLE_B=provider/modelId
# TRACE_DISTILLER_MODEL_L4=provider/modelId
```

真模型 L4：`bench --with-l4`（opt-in）。日常 CI / 本地用 `--fake-l4`。

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 工程规则  
- [docs/guides/](./docs/guides/) — 成熟度、benchmark、架构叶子等  
- [docs/adr/](./docs/adr/) — 已拍板决定  
- [docs/architecture.md](./docs/architecture.md) — 流水线与两个 agent 洞
