# enums — 有限字面量

对应路径：`src/enums/`。architecture 规定 **每个 enum 一个文件**（`label_enum.ts` / `scenario_enum.ts` / `agent_role_enum.ts` …）。本文件集中说明取值与含义。

产品词以 [CONTEXT.md](../../CONTEXT.md) 为准。

---

## 1. 目的 / 非目标

**目的**

- 把流水线里所有「四选一 / 三选一」收口成有限集合，避免各模块用不同中文/英文别名。
- 给 CutProfile、skill 路由、SQLite 列、报告筛选项同一份取值。

**非目标**

- 不做连续分数、重要性排序（那不是 Label）。
- 不在 enum 文件里写打标规则或路由表（路由表在 [constant.md](./constant.md)）。
- 不把开放的场景列表假装已经定稿——场景码是 P0/M2 仍要填的名单。

---

## 2. 输入输出

无运行时 I/O。实现时每个文件 export 一个 string enum 或 `as const` 对象。

```ts
/** src/enums/label_enum.ts */
type Label =
  | 'key_decision'          // 关键决策
  | 'useful_exploration'    // 有效探索
  | 'dead_end'              // 死胡同
  | 'routine'               // 例行操作

/** src/enums/focus_enum.ts — ADR-0009 注意力三档 */
type FocusLevel = 'line' | 'card' | 'full'

/** src/enums/cut_action_enum.ts */
type CutAction = 'keep' | 'collapse' | 'drop'

/** src/enums/warrant_source_kind_enum.ts */
type WarrantSourceKind = 'rule' | 'llm'

/** src/enums/agent_role_enum.ts — 预算分账附着点，ADR-0007/0008 */
type AgentRole =
  | 'hole_a_skeleton'       // 洞 A：头尾意图 + 骨架（含写凭证的洞 A 二次调用）
  | 'hole_b_label'          // 洞 B：逐窗打标 + 衔接检查
  | 'l4_qa'                 // 评测 QA（可降档）
  | 'l4_replay'             // 评测重放
  | 'l4_review'             // 盲测 review（干净会话；不是第三洞）

/** src/enums/trace_source_enum.ts */
type TraceSource = 'claude-code' | 'pi-session' | 'swebench'

/** src/enums/segment_outcome_enum.ts */
type SegmentOutcome = 'ok' | 'error' | 'unknown'

/** src/enums/scenario_enum.ts — 取值未拍板，见开放问题 */
type Scenario = string
```

中文对照（对外报告、文档用词必须用左列）：

| Label | 中文 | 剪辑默认（可被 CutProfile 覆盖） |
|-------|------|----------------------------------|
| `key_decision` | 关键决策 | keep |
| `useful_exploration` | 有效探索 | keep |
| `dead_end` | 死胡同 | collapse（代表性一句） |
| `routine` | 例行操作 | drop |

---

## 3. 职责与边界

**做**

- 取值、命名、与 CONTEXT 的双向对照。
- 给 TypeScript 穷尽检查用（`switch` 必须覆盖）。

**禁止**

- 增加第五个 Label「有点重要」之类的滑档。
- 把 `AgentRole` 理解成「系统里有五个 agent」。它只是 **pi 会话的预算科目**。编排器不是一个 role。
- 把场景码写死在打标 prompt 里而不经过本 enum + constant 路由表。

---

## 4. 依赖关系

```text
enums  ← 无依赖
     → types / constant / domain / 其余模块
```

enums 不准 import pipeline、agent、data、pi。

---

## 5. 关键规则 / 算法

- **四类标签**是产品核心分类，来自 PRD §4.2，不是模型自由发挥的标签集。洞 B 工具 `label_segment` 的输出必须是这四个之一。
- **注意力档**不是标签。一段可以是 `useful_exploration` 且 `focus=line`（规则已能看出来，LLM 不必读原文）。
- **CutAction 与 Label 不是一一对应**：Label 是「这段是什么」；CutAction 是「这段怎么处理」。映射由 CutProfile 声明，assembler 执行。
- **预算科目**（[ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md)）：处理成本比只计 `hole_a_skeleton` + `hole_b_label`（含衔接检查、写凭证）。`l4_*` 不得计入蒸馏成本。
- 场景分类是洞 A 的**副产品**，不单独烧一次调用（architecture 内核节）。

---

## 6. 仍开放的设计问题

1. **Scenario 名单**：MVP 要 3–5 个 skill，所以至少要 3–5 个场景码。现有文档没有列出（debug / implement / refactor？SWE-bench 任务类型？）。不定名单，路由表和 skill 文件名都没法写。
2. **要不要 `label_source` enum**（规则名空间 vs skill 名空间），还是用自由字符串 `WarrantSource.name`。
3. **`unknown` outcome** 是否允许进入洞 B，或直接 Fail-Closed Keep。
4. architecture 示例只点了三个 enum 文件；本设计多了 `focus` / `cut_action` / `trace_source`。落地时是严格跟 architecture 三个文件，还是按本文件拆——建议按本文件拆，architecture 那三个是下限不是上限。

---

## 7. 实现完成标准

- [ ] 每 enum 一文件；没有「大杂烩 enums.ts」。
- [ ] Label 恰好四个值，测试里穷尽切换。
- [ ] CONTEXT 中文词与 enum 值有对照表（可就放本文件，代码用英文值）。
- [ ] `AgentRole` 覆盖洞 A/B 与 L4 三类会话，没有「orchestrator」角色。
- [ ] Scenario 在名单拍板前，代码用 `string` + 运行时校验，或显式 `TODO` 阻塞 skill 路由实现。
