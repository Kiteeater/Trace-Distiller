# 模块设计文档

本目录把 [architecture.md](../architecture.md) v0.3 的分层，拆成可以单独开工的模块契约。

**只写设计，不是实现。** `src/` 仍为空。动工前置仍是 [TODO.md](../TODO.md) 的 P0：AgentView Trace JSON 结构体。

冲突处理（与任务约定一致）：

- **洞流程**以 [ADR-0009](../adr/0009-agent-view-and-cut-warrant.md) 为准（头尾意图 + 增量骨架，不是全量读；凭证引用式；盲测 review）。
- **分层**以 architecture v0.3 为准（契约前置、biz 不碰库、pi 只经 `agent/sessions/`、展示层只有自包含 HTML）。

产品语言以 [CONTEXT.md](../../CONTEXT.md) 为准，同一概念只用一个词。

---

## 核心观念（再钉一次）

这不是一个 agent。编排纯 TS、无 LLM；LLM 只出现在两个洞里。

```text
script/run-distill.ts          进程入口
        │
service/                       薄壳（CLI 参数、调 renderer）
        │
pipeline/orchestrator          纯 TS 控制流（无 LLM）
        │
        ├─ adapters            L0  格式 → 规范 Trace；Admission Gate
        ├─ pipeline/segmenter  L1  Action Unit → Segment / 卡片
        ├─ pipeline/rules      L1  规则打标 + 依赖图 + 注意力默认档
        ├─ agent/sessions      洞 A / 洞 B（唯一 pi 依赖）
        ├─ pipeline/assembler  执行 CutWarrant；span；同源双产物
        ├─ data/               SQLite（biz 只走这里）
        ├─ eval/               L4 数字
        └─ report/             HTML 字符串（不是 GUI，不是本地 server）
```

---

## 文档索引

| 文档 | 对应路径 | 层 / 角色 |
|------|----------|-----------|
| [types.md](./types.md) | `src/types/` | 契约：RawTrace / AgentView / SegmentCard / CutPlan / CutWarrant / CutProfile |
| [enums.md](./enums.md) | `src/enums/` | 契约：标签 / 场景 / 角色 / 注意力档 / 裁剪动作 |
| [constant.md](./constant.md) | `src/constant/` | 契约：阈值、窗口、skill 路由表 |
| [domain.md](./domain.md) | `src/domain/` | 纯模型：LabelDecision / CutDecision / SpanViolation |
| [adapters.md](./adapters.md) | `src/adapters/` | **L0** 解析对齐 + Admission Gate |
| [pipeline-segmenter.md](./pipeline-segmenter.md) | `src/pipeline/segmenter.ts` | **L1** 切段 |
| [pipeline-rules.md](./pipeline-rules.md) | `src/pipeline/rules.ts` | **L1** 规则层 |
| [pipeline-orchestrator.md](./pipeline-orchestrator.md) | `src/pipeline/orchestrator.ts` | 流水线编排（无 LLM） |
| [pipeline-assembler.md](./pipeline-assembler.md) | `src/pipeline/assembler.ts` | 执行凭证 + span + 导出投影 |
| [agent-sessions.md](./agent-sessions.md) | `src/agent/sessions/` | **洞 A** `skeletonPass` / **洞 B** `labelWindow` |
| [agent-extension.md](./agent-extension.md) | `src/agent/extension.ts` | 洞内工具：`label_segment` / `check_continuity`（+ 确定性 `read_segment`） |
| [agent-skills.md](./agent-skills.md) | `src/agent/skills/` | 分场景 Markdown skill |
| [data.md](./data.md) | `src/data/` | SQLite：段 / 打标 / 凭证 / 指标 |
| [eval.md](./eval.md) | `src/eval/` | **L4** 压缩率、成本、QA、重放、盲测 review |
| [report.md](./report.md) | `src/report/` | 自包含 HTML（Playback Cut 的实例化） |
| [service.md](./service.md) | `src/service/` | 入口薄壳：`cli.ts` / `report.ts` |
| [utils.md](./utils.md) | `src/utils/` | 仅无状态：token 估算、jsonl、logger |
| [script-run-distill.md](./script-run-distill.md) | `script/run-distill.ts` | 进程入口 |

---

## 与 L0–L4 / 洞 / 展示 的映射

| 架构位置 | 谁干活 | 有没有 LLM |
|----------|--------|------------|
| L0 适配器 | `adapters/` | 无 |
| L1 切段 + 规则 | `pipeline/segmenter` + `pipeline/rules` | 无 |
| 洞 A（0009：头尾意图 + 增量骨架） | `agent/sessions.skeletonPass` | 有，仅此 |
| 洞 B（逐窗打标；衔接检查复用） | `agent/sessions.labelWindow` | 有，仅此 |
| 凭证执行 + 双产物投影 | `pipeline/assembler`（L3 导出也在这） | 无（必要时调洞 B 做 `check_continuity`） |
| L4 评测 | `eval/` | 统计无 LLM；QA / 重放 / 盲测 review 用 pi **干净会话**，经 `agent/sessions` 工厂，不算第三洞 |
| 展示 | `report/` | 无 |
| 入口 | `service/` + `script/run-distill.ts` | 无 |

洞 A / 洞 B 的会话封装是 **唯一允许 `import` pi SDK 的地方**。`eval/` 要起干净会话，也必须走 `agent/sessions` 提供的工厂，不能自己 `createAgentSession()`。

---

## 分层纪律（所有模块共用）

1. **契约前置**：`types` / `enums` / `constant` 先于一切实现。P0 结构体不定，segmenter / rules / 卡片流不能并行开工。
2. **biz 不碰库**：`pipeline/` 与 `agent/` 只调 `data/` 函数，禁止直接 `sqlite` / 文件数据库句柄。
3. **pi 只经 sessions**：`extension`、`skills`、`orchestrator`、`eval` 都不直接碰 pi。
4. **utils 无状态**：有状态的进 `domain/` 或 `data/`。
5. **service 薄壳**：参数解析、调 renderer、退出码。流水线步骤顺序不写在 CLI 里。
6. **不做 GUI / 本地 web server**。展示层只有一个 `.html` 文件。
7. **不引入 LangChain 等编排框架**。失败 Trace 不分析（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）。

---

## 建议阅读顺序

1. 本索引 → [types.md](./types.md) → [enums.md](./enums.md) → [constant.md](./constant.md) → [domain.md](./domain.md)
2. [adapters.md](./adapters.md) → [pipeline-segmenter.md](./pipeline-segmenter.md) → [pipeline-rules.md](./pipeline-rules.md)
3. [agent-sessions.md](./agent-sessions.md) → [agent-extension.md](./agent-extension.md) → [agent-skills.md](./agent-skills.md)
4. [pipeline-orchestrator.md](./pipeline-orchestrator.md) → [pipeline-assembler.md](./pipeline-assembler.md)
5. [data.md](./data.md) → [eval.md](./eval.md) → [report.md](./report.md)
6. [service.md](./service.md) → [utils.md](./utils.md) → [script-run-distill.md](./script-run-distill.md)

落地顺序仍以 architecture「落地顺序」为准：契约 → L0+L1+SQLite → 无洞保守导出 → 报告骨架 → 洞 A → 洞 B → assembler → eval。
