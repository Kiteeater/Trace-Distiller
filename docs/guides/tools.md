# Distiller 洞内工具

流水线里唯一允许 LLM 动手的地方是两个 **Agent 洞**（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。洞里的模型不能「写一篇我认为该删什么」，只能通过工具交结构化判断。判断力工具只有两个；另有一个确定性取数通道。

这是 **Distiller 自己的工具**，不是被裁剪的那个 agent 的工具。两者不要混。

字段级 schema 见 [agent-extension.md](../modules/agent-extension.md)；谁开会话见 [agent-sessions.md](../modules/agent-sessions.md)。本文件只讲「有哪些、为什么只有这些、明确不加什么」。

---

## 目的

- 给实现者和写 skill 的人一张闭集：洞里能调什么。
- 把「Distiller 工具」和「原料 Trace 里出现的对方工具」切开，避免有人去做代理 / 重放对方的 Read、Bash。
- 解释 architecture「不加第三个工具」和 TODO 里 `read_segment` 如何同时成立。

---

## 读者

- 实现洞 A / 洞 B / extension 的人。
- 写分场景 skill 的人（需要知道模型该调什么、不该幻想有什么）。
- 误以为 Distiller 会「替原 agent 再跑一遍工具」的人——请先读「和对方工具的区别」。

日常用户（只要 Training Cut / 只要看报告）不必读本文件，见 [users-and-surfaces.md](./users-and-surfaces.md)。

---

## 已定结论

1. **判断力工具只有两个**（[architecture.md](../architecture.md)）：`label_segment`、`check_continuity`。不加第三个判断力工具。工具越多，洞里的模型越分心，成本卖点就没了。
2. **`read_segment` 不是判断力工具**。它是确定性取数：按 segment id 把 RawTrace 原文拉上来，把注意力从卡片升到 `full`。由 extension 提供、sessions 接到 RawTrace。架构要的「两个判断工具」仍然成立。
3. **LLM 只产出结构化判断，裁剪由代码执行**（ADR-0009）。没有 `edit_trace`、没有 `drop_segment`、没有 `set_profile`。去留写在 CutWarrant 里，assembler 落地。
4. **注意力是拉取式，不是推送式**。默认给卡片（规则已决议的噪音段只给 line）；模型对某段没把握才 `read_segment`。token 花在它主动关心的段上。禁止 orchestrator 预塞全量原文。
5. **衔接检查复用洞 B，不是第三洞**。`check_continuity` 挂在洞 B 会话上；编排器在 assembler 需要时调用。
6. **我们不代理被裁剪 agent 的工具**。对方的 Read / Edit / Bash / 测试命令是 Trace **数据**，出现在 RawTrace 里。Distiller 不调用、不转发、不重跑它们。

`rewrite_skill` 是 architecture 留的活口，M3+ 才考虑，现在不加。

---

## 怎么用 / 怎么跑

洞里实际能调用的就这三件事：

| 名字 | 性质 | 谁用 | 交什么 |
|------|------|------|--------|
| `label_segment` | 判断 | 洞 B 逐窗打标 | 这一段的四类 Label + 置信度（可选短理由，给调试 / 报告，不是改写段内容） |
| `check_continuity` | 判断 | 重组时的衔接检查（洞 B 会话） | 相邻两段是否够得着、分数、理由。对齐「从前一步能否自然推出后一步」，不是文笔 |
| `read_segment` | 确定性取数 | 洞 B 需要看原文时 | 只返回**这一段**的 RawTrace 原文。想看邻段就再调一次 |

### 为什么是这个闭集

洞的工作只有两类判断：这段是什么标签；剪完相邻步能不能接上。取数是为了让判断不必一上来吞全文。再加任何「执行类」工具，都会把裁剪权从代码抢回到模型——那正是 ADR-0009 要堵的。

规则层已经标死的段**根本不进洞 B**（见 [ingest-and-preprocess.md](./ingest-and-preprocess.md)）。模型在卡片索引上也许能看见 line 级噪音，skill 应写明：忽略，不要再标一遍。

模型没调 `label_segment` 就结束、或输出解析失败 / 超 token：编排器 **Fail-Closed Keep**（宁多勿漏），而不是 extension 填一个默认死胡同。漏关键决策会打穿关键步召回。

### 调用纪律（给 skill 和实现）

- **按段打标**。一次 `label_segment` 必须带 `segment_id`；可以连调多次。不许「这一窗全是例行」而不给 id。
- **聚类成员不要让模型代标**。`rep_of` 由规则层处理；代表段未决才进洞。
- **`read_segment` 付费看原文**。只返回该 id，未知 id 报错，不顺带塞相邻三段。
- **`label_segment` 的 rationale 非正式凭证字段**。CutWarrant 认的是 source + 置信度 + 死胡同一句话摘要。短理由最多进调试 / 报告文案，凭证生成不得依赖它。
- **handler 里不调 LLM、不写 SQLite、不做 keep/drop**。extension 只校验枚举、转发、取数。

洞 A（头尾意图 + 增量骨架）**不靠这套工具写卡片**。卡片字段要么原文截取、要么规则计算，零 LLM。洞 A 读的是锚点 turns + 卡片索引，不是全量 Trace。

### 和「被裁剪的 agent 自己的工具」的区别

| | Distiller 洞内工具 | 原料里的对方工具 |
|--|-------------------|------------------|
| 出现位置 | pi 会话的 extension | RawTrace 的 tool_call / tool_result |
| 调用者 | 洞 A/B 里的打标 / 衔接模型 | 当时干活的那个 coding agent |
| 作用 | 交 Label / 交连贯性 / 拉本段原文 | 读文件、改代码、跑测试…… |
| Distiller 会不会再跑一遍 | 会（仅上表三个） | **不会** |

对方工具的名字、参数、返回，是切段和规则的输入（失败调用、重复读、读写路径）。我们把它们当成日志来读，不把 Distiller 洞变成「原 agent 的运行时」。评测重放（L4）若按剪后路径重做任务，那是**干净会话里的新 agent** 自己去调工具，仍然不是 Distiller 代理对方当时的那次调用。

---

## 边界（非目标）

明确不加：

- **第三个判断力工具**（包括「一窗打完返回」的批量 label、自动 keep/drop）。
- **`edit_trace` / `drop_segment` / `keep_segment` / `set_profile`**。裁剪权和 profile 在代码 / CLI。
- **`rewrite_skill`**。目录可以先在，工具 M3+ 再说。
- **Bash / 读用户仓库 / 联网 / 跑测试**。洞里的模型没有这些。
- **代理或重放对方工具**（Read、Edit、Bash、SWE-bench 评测脚本等）。
- **一次 `read_segment` 返回窗口全文或邻段**。强迫注意力付费。
- **在工具 handler 里做业务决策**（改标签政策、跑 assembler、写 warrant）。

评测用的 QA / 重放 / 盲测 review 走 `agent/sessions` 工厂起干净会话，**不算第三洞**，也不往那些会话上挂 `label_segment`。review 故意不给 CutWarrant 和骨架。

---

## 开放问题

1. **`read_segment` 的挂载方式**（[agent-extension.md](../modules/agent-extension.md)）：现在的设计是非判断力 pi tool，以同时满足「两个判断工具」和「拉取式注意力」。若审阅要求字面「工具列表只有两个」，则改成 sessions 在 prompt 外的 RPC，而不是 pi tool。未在 ADR 关闭。
2. **`check_continuity` 分数是否强约束为 1–5**（对齐 benchmark 连贯性量表）。
3. **洞 B 一窗一会话还是多窗复用**。MVP 建议一窗一会话，贵但干净；工具状态泄漏风险是复用的代价。
4. **pi SDK spike 未做**：结构化输出、自定义消息序列、provider 降档——工具声明的具体写法以 spike 为准，本文件不锁 SDK API。

---

## 完成标准

- [ ] extension 注册表快照里，判断力工具恰好为 `label_segment`、`check_continuity`；另可有确定性 `read_segment`；无 `edit_trace` 一类。
- [ ] 非法 Label 被工具层拒绝；未知 `segment_id` 的 `read_segment` 报错且不返回其它段。
- [ ] handler 无 sqlite、无二次 LLM、无对对方工具的转发。
- [ ] 模型不调 `label_segment` 就结束时，该窗 Fail-Closed Keep，而不是被标成死胡同。
- [ ] skill 文档写明：只使用本闭集；trace 里的对方工具调用是数据不是可调工具。
- [ ] 全仓库不出现「Distiller 代理原 agent 工具」的实现或指南表述。
