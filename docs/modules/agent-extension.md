# agent/extension — 洞内工具

对应路径：`src/agent/extension.ts`。往 pi 会话注册自定义工具。判断力工具 **只有两个**（architecture）：`label_segment` / `check_continuity`。

TODO P0 另要求 `read_segment`：洞 B 从卡片升级到 full 的注意力闭环。它**不是判断力工具**，是确定性取数，由本 extension 提供、由 sessions 接到 RawTrace。

---

## 1. 目的 / 非目标

**目的**

- 让洞里的模型只能通过工具交结构化判断，而不是输出一篇「我认为应该删掉这些」。
- 提供拉取原文的唯一合法通道，避免 orchestrator 预塞全量。

**非目标**

- 不在工具 handler 里做业务决策（不改标签政策、不跑 assembler）。
- 不加第三个判断力工具。工具越多洞里的模型越分心，成本卖点没了。
- 不实现 `rewrite_skill`（architecture 活口，M3+）。
- 工具 handler 不直接 SQLite。读原文从 sessions 传入的 RawTrace / 内存索引取。

---

## 2. 输入输出

工具 schema 草图（pi 的具体声明方式以 spike 为准，字段契约如下）：

```ts
/** 判断力工具 1 */
function label_segment(args: {
  segment_id: string
  label: Label                 // 四选一，枚举约束
  confidence: number           // 0–1
  rationale?: string           // 给报告用的短理由；不是改写段内容
}): { ok: true }

/** 判断力工具 2 */
function check_continuity(args: {
  left_id: string
  right_id: string
  reachable: boolean
  score: number                // 强约束 1–5，与 benchmark 连贯性量表对齐
  reason: string
}): { ok: true }

/** 确定性取数，不是判断 */
function read_segment(args: {
  segment_id: string
}): {
  segment_id: string
  focus: 'full'
  text: string                 // RawTrace 原文，按 raw_refs 拼接
}
```

extension 只定义 schema + 把调用转发到 sessions 注入的 ctx。真正拼 `text` 的函数应是纯的，可单测。

---

## 3. 职责与边界

**做**

- 注册工具、校验枚举、拒绝非法 label。
- `read_segment` 只返回该段原文，不返回「相邻三段方便看看」。想看邻段就再调一次——强迫注意力付费。
- 把每次工具调用的参数记入返回给 sessions 的日志，便于 warrant 的 source/confidence 取值。

**禁止**

- handler 里调 LLM。
- handler 里写库。
- 提供 `drop_segment` / `edit_trace` / `set_profile` 之类执行类工具。裁剪权在代码。
- 让 `label_segment` 一次标一整窗而不给 id——必须按段。可允许多次调用。

---

## 4. 依赖关系

```text
extension → types, enums, domain（校验）
         ← sessions 在 create 时注册
         ✗ pipeline / data / pi 的编排 API（可以依赖 pi 的 tool 类型定义）
```

extension 允许依赖 pi 的 **tool 类型**，但不允许 `createAgentSession`。开会话是 sessions 的事。

---

## 5. 关键规则 / 算法

- **LLM 只产出结构化判断，裁剪由代码执行**（ADR-0009）。这两个判断力工具就是那条原则的 API。
- **拉取式注意力**：默认卡片；模型对某段没把握才 `read_segment`。token 花在它主动关心的段上。
- **连贯性工具**对齐 ADR-0004 / benchmark 指标 5：要的是「从前一步能否自然推出后一步」，不是文笔。
- Fail-Closed 发生在 sessions/orchestrator：模型没调 `label_segment` 就结束 → 该窗 keep，而不是 extension 填默认死胡同。

---

## 6. 仍开放的设计问题

闭集、rationale 不进凭证、`check_continuity` 分数 1–5、聚类成员不让模型代标：已拍板。

1. **`read_segment` 挂成 pi tool 还是 sessions RPC**：handler 纯函数已落地；挂载点等 pi spike。本仓库仍不 import pi。

---

## 7. 实现完成标准

- [x] 非法 Label 被工具层拒绝。
- [x] `read_segment` 对未知 id 返回错误，不返回其它段。
- [x] 无 `edit_trace` 类工具的注册表快照测试。
- [x] handler 无 sqlite、无二次 LLM。
- [x] 与 sessions 的集成测试（mock 模型调工具）能得到 LabelDecision。
