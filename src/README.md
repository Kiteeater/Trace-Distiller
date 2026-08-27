# src

实现根目录。**TypeScript + Node**；边界以 [docs/architecture.md](../architecture.md) 为准。

核心观念：**流水线 + 两个 agent 洞**——编排纯代码；LLM 只出现在洞 A / 洞 B。

```text
src/
  adapters/            # L0: pi session / claude-code / swebench → 规范 Trace
  pipeline/
    segmenter.ts       # 切段
    rules.ts           # 规则打标
    orchestrator.ts    # 纯 TS 编排（无 LLM）
    assembler.ts       # 全局重组 + Span 约束
  agent/               # pi 二开（仅两洞）
    extension.ts       # label_segment / check_continuity
    skills/            # 分场景 Markdown skill（先 3–5 个）
    sessions/          # 骨架 / 打标会话封装（内核可换边界）
  eval/                # L4: 指标统计 + QA + 重放
```

落地顺序见 architecture「落地顺序」。当前为空，待按契约开工。
