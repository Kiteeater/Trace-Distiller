# types — Trace 契约

对应路径：`src/types/`（实现时拆 `trace.ts` / `segment.ts` / `label.ts` / `cut_plan.ts` 等；本文件是字段级设计，不是可运行代码）。

这是动工前置。字段没钉死之前，不要写 segmenter / rules / 卡片渲染。权威来源：[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)、[TODO.md](../TODO.md) P0。

---

## 1. 目的 / 非目标

**目的**

- 给整条流水线一份可序列化的 JSON 契约：原料、卡片流、凭证、剪辑计划、用户自定义面。
- 物理上把 **RawTrace（原文）** 和 **AgentView（卡片流）** 分成两份。LLM 只看 AgentView；Training Cut 回原文；Playback Cut 走卡片。同一份 [CutPlan](#cutplan) 两种投影（[ADR-0003](../adr/0003-dual-cut-outputs.md)）。

**非目标**

- 不在 types 里写解析、打标、裁剪算法。
- 不让 LLM 生成任何卡片字段。卡片要么原文截取，要么规则计算。
- 不把 SQLite 行结构写进这里（那是 [data.md](./data.md)）。types 是跨层 JSON；表是它的落盘形状。
- 不在这里发明第三种「给人看的摘要对象」——报告吃的就是 Playback Cut + CutWarrant。

---

## 2. 输入输出

本模块无运行时 I/O。它定义其它模块互相传递的形状。

### RawTrace

原文。保真、审计、Training Cut 用。LLM **永远不看全量**。

```ts
type TraceId = string

type TraceSource = 'claude-code' | 'pi-session' | 'swebench'

interface GroundTruth {
  kind: 'tests_passed' | 'task_confirmed'
  /** 指向原料里可独立核对的证据（测试日志路径、断言、提交 SHA 等），不是 LLM 写的 */
  evidence_ref: string
}

interface TraceMeta {
  trace_id: TraceId
  source: TraceSource
  ground_truth_ref: string
  total_tokens: number
}

interface RawTurn {
  id: string
  /** 实现时按适配器对齐；此处只要求能还原「思考 / 工具调用 / 返回」 */
  role: 'thought' | 'tool_call' | 'tool_result' | 'user' | 'assistant'
  content: string
  tool?: { name: string; args_json: string }
  tokens: number
}

interface RawTrace {
  meta: TraceMeta
  ground_truth: GroundTruth
  turns: RawTurn[]
}
```

一条 RawTrace = **一个任务**。Claude Code 一条 session 常含多个任务，切开是 adapter 的事，见开放问题。

### AgentView

LLM 唯一可见的形态。L0 之后由 segmenter + rules **纯代码**生成，洞 A 只往 `intent_hypothesis` / `skeleton` 上做增量修正（修正仍是结构化补丁，由代码合并，不是让 LLM 重写卡片）。

```ts
type FocusLevel = 'line' | 'card' | 'full'

interface SegmentCard {
  id: string
  tool: string
  /** 动作签名：同质动作聚类的键。生成规则未拍板，见开放问题 */
  sig: string
  outcome: 'ok' | 'error' | 'unknown'
  /** 相似重试聚类：指向代表段 id；自己就是代表则为 null */
  rep_of: string | null
  reads: string[]
  writes: string[]
  tokens: number
  /** 默认档由规则代码决定，不是 LLM */
  focus: FocusLevel
  /** 原文截首句 / 首行，禁止 LLM 生成 */
  head: string
  /** 指回 RawTrace 的 turn id 列表，投影 Training Cut 用 */
  raw_refs: string[]
}

interface IntentHypothesis {
  version: number          // v0 = 洞 A 头尾推断；v1+ = 窗回报合并
  text: string
  scenario?: Scenario      // debug|implement|refactor|test_fix|investigate；缺省 / 非法码走 SKILL_ROUTE 回退 implement
}

interface SkeletonNode {
  id: string
  kind: 'turning_point' | 'main_path_hypothesis' | 'verification_anchor'
  /** 引用段 id，不是改写后的散文 */
  segment_ids: string[]
  note: string
}

interface Skeleton {
  version: number
  nodes: SkeletonNode[]
}

interface AgentView {
  meta: TraceMeta
  intent_hypothesis: IntentHypothesis
  skeleton: Skeleton
  segments: SegmentCard[]
}
```

注意力三档（代码给默认值，洞 B 用 `read_segment` 升级到 full）：

| 档 | 卡片上实际给 LLM 看什么 |
|----|-------------------------|
| `line` | `sig` + `rep_of`（噪音段） |
| `card` | 签名 + outcome + reads/writes + head（默认） |
| `full` | 经 `read_segment` 拉 RawTrace 原文 |

### CutWarrant

引用式凭证。agent / 规则只决定段的去留，不改写段内容。唯一允许的改写：死胡同一句话摘要。

```ts
type CutAction = 'keep' | 'collapse' | 'drop'

interface WarrantSource {
  kind: 'rule' | 'llm'
  /** 规则名，或洞 B skill 名 */
  name: string
}

interface CutWarrantEntry {
  segment_id: string
  action: CutAction
  source: WarrantSource
  confidence: number          // 0–1；规则层可给 1
  /** 仅 action === 'collapse' 时出现 */
  dead_end_summary?: string
}

interface CutWarrant {
  trace_id: TraceId
  /** 覆盖 AgentView.segments 的每一个 id，禁止漏段 */
  entries: CutWarrantEntry[]
}
```

### CutPlan

assembler 执行凭证、跑完 span 之后的**保留集**。Training Cut / Playback Cut 都从这里投影，禁止各剪各的。

```ts
interface CutPlan {
  trace_id: TraceId
  profile_id: string
  warrant_ref: string         // 指向本轮 CutWarrant
  kept: string[]              // segment id，保序
  collapsed: Array<{ segment_id: string; summary: string }>
  dropped: string[]
  span_ok: boolean
  span_violations: string[]   // SpanViolation id，细节在 domain
}
```

### CutProfile

用户自定义面。CLI 吃 profile 跑；对话调优（M3 以后）也只能改 profile，不能让 agent 直接改 trace。

```ts
interface SpanPolicy {
  /** 相邻 keep 之间允许跨过的最大段数。具体数字未拍板 */
  max_gap_segments: number
  /** 是否允许用 collapse 的一句话填缺口 */
  fill_with_representative_dead_end: boolean
}

interface DeadEndPolicy {
  max_representative: number
  summary_max_chars: number
}

interface CutProfile {
  id: string
  keep_labels: string[]       // Label 枚举值
  collapse_labels: string[]
  drop_labels: string[]
  compression_ratio: { min: number; max: number }  // 默认 0.10–0.30
  span: SpanPolicy
  dead_end: DeadEndPolicy
}
```

### 双产物（投影结果，不是第三份剪辑逻辑）

```ts
interface TrainingCut {
  trace_id: TraceId
  plan_ref: string
  /** RawTrace 原文按 CutPlan.kept / collapsed 拼出的 SFT 序列 */
  turns: RawTurn[]
}

interface PlaybackCut {
  trace_id: TraceId
  plan_ref: string
  /** AgentView 卡片流按同一 CutPlan 投影 */
  cards: SegmentCard[]
  collapsed: Array<{ segment_id: string; summary: string }>
}
```

M1 可先只落一份中间剪后表示（CutPlan + 投影前的段列），M2 再分叉这两种格式。

---

## 3. 职责与边界

**做**

- 成为 JSONL I/O、SQLite 序列化、洞输入输出、报告内嵌 JSON 的共用形状。
- 用 `raw_refs` / `segment_id` 做引用，不复制大段原文到卡片里。

**禁止**

- 卡片字段由 LLM 填写。
- CutWarrant 改写 `keep` 段的 content。
- 为「报告好看」另定义一套会改因果路径的摘要类型（[ADR-0003](../adr/0003-dual-cut-outputs.md)）。
- 把窗口、重试、pi 会话句柄放进契约。

---

## 4. 依赖关系

```text
types  ← 无代码依赖（可依赖 enums 的字面量）
     → 被所有模块依赖
```

- 只引用 [enums.md](./enums.md) 的字符串字面量，不引用 pipeline / agent / data。
- `biz` 与 `data` 都 import types，不允许在 data 层另搞一套列名不同的「影子结构」而不映射回来。

---

## 5. 关键规则 / 算法

- **两份物理结构**：[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md) §5。RawTrace 保真；AgentView 管注意力。
- **引用不是改写**：凭证只含 id + 动作 + 来源 + 置信度；死胡同摘要是唯一改写口。
- **同源投影**：CutPlan 一份，Training 回原文、Playback 走卡片。
- **意图增量**：`IntentHypothesis.version` / `Skeleton.version` 从 v0（洞 A 头尾）到 v1（窗回报由代码合并），不是一次读完全量。
- **Admission Gate 的数据形状**：`GroundTruth` 必须存在，否则 adapters 拒绝——类型上不要做成可选「以后再补」。

---

## 6. 仍开放的设计问题

全部来自 [TODO.md](../TODO.md) P0，**本文件给了草图，不等于已拍板**：

1. **`sig` 生成规则**：什么算同质动作？工具名 + 归一化路径？是否含参数哈希？聚类粒度直接影响规则层覆盖率。
2. **session ≠ trace**：多任务 session 怎么切成「一条 trace = 一个任务」。切错则意图推断和切段都漂。
3. **注意力默认档规则集**：哪些条件给 `line` / `card` / `full`（代码决定）。
4. **token 计量口径**：`TraceMeta.total_tokens` 和压缩率的分子分母——工具输出全文算不算、卡片算不算。口径不定，10%–30% 没法验收。
5. **验证点定位**：`ground_truth` 附近哪几个 turn 算意图锚点；头尾是启发式，验证点是硬锚点。
6. **CutProfile 默认值**：`max_gap_segments`、死胡同最多留几条，现有文档只有原则没有数字。
7. **RawTurn.role 是否够用**：Claude Code / pi session / SWE-bench 三套原文是否能对进这五个 role，要等第一条真实原料。
8. **`outcome: unknown` 的准入**：规则层看不到明确退出码时，是标 unknown 送洞 B，还是当解析失败整段保守不裁。

---

## 7. 实现完成标准

- [ ] `src/types/` 与本文件草图字段一一对应；每份 JSON 能 round-trip。
- [ ] 有 JSON Schema 或等价校验：缺 `ground_truth` 的 RawTrace 校验失败。
- [ ] AgentView 的卡片字段全部可从 RawTrace + 规则追溯，无「LLM 生成」字段。
- [ ] CutWarrant.entries 覆盖全部 segment id 的不变量有类型或校验函数（函数本身可放 domain）。
- [ ] TrainingCut / PlaybackCut 都只引用 CutPlan id，不自带另一套 keep 列表。
- [ ] 上列开放问题在 types 落地前必须先在 TODO/ADR 关闭，或显式写成 `// OPEN:` 并阻塞依赖模块的实现。
