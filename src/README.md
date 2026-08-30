# src

实现根目录。**TypeScript + Node**（bun 装依赖，node 跑产物）；架构与分层见 [docs/architecture.md](../docs/architecture.md)。

核心观念：**流水线 + 两个 agent 洞**——编排纯代码；LLM 只出现在洞 A / 洞 B。

分层纪律（参考 macaron-agent，裁掉在线服务那套）：

- **契约前置**：types / enums / constant 先写，一切实现以契约为准
- **biz 纯逻辑**：pipeline / agent 不碰 IO 入口，不直接碰库
- **service 薄壳**：CLI 入口、报告调用；换展示形态只动这层
- **data 统一管库**：SQLite 读写只出现在 data/，biz 全走 data 层函数
- **utils 只放无状态小函数**：状态相关的一律进 domain / data

```text
src/
  types/             # Trace 契约：trace.ts segment.ts label.ts cut_plan.ts
  enums/             # label / scenario / agent_role（每 enum 一文件）
  constant/          # 压缩率目标、窗口大小、保守不裁阈值、skill 场景路由表
  domain/            # LabelDecision / CutDecision / SpanViolation 纯模型
  adapters/          # L0: pi session / claude-code / swebench → 规范 Trace
  pipeline/          # biz: segmenter / rules / orchestrator / assembler
  agent/             # pi 二开（仅两洞）
    sessions/        #   skeletonPass / labelWindow（唯一 pi 依赖点）
    extension.ts     #   label_segment / check_continuity
    skills/          #   分场景 Markdown skill（先 3–5 个）
  data/              # SQLite：打标结果、指标
  eval/              # L4: 指标统计 + QA + 重放
  service/           # 入口薄壳：cli.ts / report.ts
  report/           # HTML 报告渲染（纯函数：结果 JSON → html 字符串）
  utils/            # token 估算 / jsonl 读写 / logger
```

落地顺序见 architecture「落地顺序」。当前为空，待按契约开工。
