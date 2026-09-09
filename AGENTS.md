# AGENTS

工程规则。分层理由见 `docs/architecture.md`；叶子树见 `docs/guides/file-architecture.md`。

## 命令

- 装依赖：`bun install`（锁文件只用 `bun.lock`）
- 类型检查：`bun run typecheck`（`tsc --noEmit`）
- 跑产物：`node`（不要用 bun 当运行时入口）

蒸馏入口 `script/run-distill.ts` 目前打印「未实现」并以退出码 1 结束。不要在本轮实现蒸馏逻辑。

## 分层

- 契约前置：`types` / `enums` / `constant` / `domain`
- pipeline / agent 不直接碰 SQLite，不写 CLI 入口逻辑
- service 薄壳；`live.ts` 只读订阅 Distiller 裁剪进度，不进 pipeline，不 import pi
- 库操作只走 `data/`
- utils 只放无状态小函数
- `createAgentSession` 只允许出现在 `src/agent/sessions/`
- 禁止 `src/gateway/`、`src/runtime/`、`src/biz/`、`src/agents/`
- 每 enum 一文件；不要 `package-lock.json`
