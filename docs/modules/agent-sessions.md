# agent/sessions — 两个 agent 洞（唯一 pi 依赖）

对应路径：`src/agent/sessions/`。architecture：**需要封装的只有两个函数**。

```text
skeletonPass(...)   → 意图 + 骨架 + 场景分类     【洞 A】
labelWindow(...)    → 四类标签 + 置信度           【洞 B】
```

洞流程以 [ADR-0009](../adr/0009-agent-view-and-cut-warrant.md) 为准：**洞 A 不是全量读 Trace**，是头尾意图 + 增量骨架。

本目录是全仓库 **唯一允许 import pi SDK**（`createAgentSession` 等）的地方。eval 的干净会话也走这里的工厂函数。

---

## 1. 目的 / 非目标

**目的**

- 把「一次 LLM 判断」收成两个稳定函数，让 orchestrator 像调普通 async 函数一样调洞。
- 注入骨架 context、挂上 extension 工具、选用 skill 文件、要结构化 JSON 输出。
- 按 `AgentRole` 分账（[ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md)）：洞 A / 洞 B / L4 不得混用同一配额计数。

**非目标**

- 不是 Distiller Agent，不编排流水线。
- 不切段、不跑规则、不执行裁剪、不写 HTML。
- 不让会话里的模型决定下一步跑规则还是跑 assembler。
- 不直接读写 SQLite（token 用量返回给调用方，由 data 记账）。
- 不引入 LangChain / CrewAI。

---

## 2. 输入输出

### 工厂（给 L4 复用，不算第三洞）

```ts
interface SessionFactoryOpts {
  role: AgentRole
  model?: string
}

/** 内部用。eval 的 QA / replay / review 必须走这个，禁止自己 createAgentSession */
function openSession(opts: SessionFactoryOpts): PiSessionHandle
```

### 洞 A — skeletonPass

ADR-0009：主过程只读头 1–2 turn + **验证点附近** turn（不是死板末尾），约 2k token，一次调用。输出意图假设 v0 + 场景分类 + 骨架 v0。

```ts
interface SkeletonPassInput {
  trace_id: TraceId
  /** adapter 标出的锚点；sessions 按 id 从 RawTrace 取原文，不得擅自改读全量 */
  head_turn_ids: string[]
  verification_turn_ids: string[]
  raw: RawTrace
  view: AgentView            // 用卡片理解「有哪些段」，默认 line/card，不塞 full 原文
}

interface SkeletonPassOutput {
  intent: IntentHypothesis   // version = 0
  scenario: string
  skeleton: Skeleton         // version = 0
  usage: TokenUsage          // 记入 hole_a_skeleton
}

function skeletonPass(input: SkeletonPassInput): Promise<SkeletonPassOutput>
```

**禁止**把 `raw.turns` 全量放进洞 A prompt。这是 0009 相对 architecture 旧「对整条 Trace 抽骨架」的修正。

### 洞 A 二次调用 — 写 CutWarrant（建议）

architecture 公开函数仍是两个；0009 第 ③ 步需要一份 JSON 凭证。建议同目录导出：

```ts
interface WriteWarrantInput {
  skeleton: Skeleton         // v1
  labels: LabelDecision[]    // 规则 + 洞 B
  view: AgentView            // 卡片，默认不要 full
  profile: CutProfile
}

function writeWarrant(input: WriteWarrantInput): Promise<CutWarrant>
```

实现上仍开 **洞 A 角色** 的会话（同一预算科目）。若后续改为纯代码生成 warrant，删除此函数即可，orchestrator 已在 [pipeline-orchestrator.md](./pipeline-orchestrator.md) 把这步隔离。

### 洞 B — labelWindow

```ts
interface LabelWindowInput {
  segment_ids: string[]
  view: AgentView
  raw: RawTrace              // 仅供工具 read_segment 拉取，不预塞进 prompt
  skeleton: Skeleton
  intent: IntentHypothesis
  skill_path: string         // orchestrator 查表后传入
}

interface SkeletonPatch {
  upsert_nodes: SkeletonNode[]
  remove_node_ids: string[]
}

interface LabelWindowOutput {
  decisions: LabelDecision[] // source.kind = 'llm'；label 必须是四选一
  skeleton_patch?: SkeletonPatch
  usage: TokenUsage          // hole_b_label
}

function labelWindow(input: LabelWindowInput): Promise<LabelWindowOutput>
```

洞里模型通过工具 `label_segment` 交答案；通过 `read_segment` 把某张卡片升级到 full。sessions 负责把工具结果拦下来变成 LabelDecision，而不是解析一段自由散文。

### 衔接检查（复用洞 B 会话，不是新洞）

```ts
function checkContinuityPair(
  left: SegmentCard,
  right: SegmentCard,
  skeleton: Skeleton,
): Promise<{ ok: boolean; score: number; reason: string; usage: TokenUsage }>
```

assembler / orchestrator 在「必要时」调用。工具是 `check_continuity`。

### L4 干净会话

```ts
function openReviewSession(): PiSessionHandle   // role = l4_review；不注入 warrant/骨架
function openReplaySession(): PiSessionHandle   // role = l4_replay
function openQaSession(): PiSessionHandle       // role = l4_qa，可降档模型
```

盲测的关键：review 会话 **故意不给 CutWarrant 和骨架**（ADR-0009 §4）。只给任务意图 + 剪后 trace。

---

## 3. 职责与边界

**做**

- 创建/关闭 pi 会话，挂 extension，注入 system context（骨架 + skill）。
- 结构化输出；解析失败向上抛，让 orchestrator Fail-Closed，而不是在洞里「猜一个标签」。
- 记录 usage（input/output tokens）按 role 返回。
- 限制洞 A 的可见 turns。这是注意力设计的实现点，不是调用方的礼貌约定。

**禁止**

- 在 sessions 里跑 segmenter/rules/assembler。
- 写 SQLite。
- 给洞 B 预推 full 原文。注意力闭环是拉取式。
- 给 review 会话偷看凭证。
- 增加第三个判断力工具（见 [agent-extension.md](./agent-extension.md)）。`read_segment` 是确定性取数，不是判断力工具。

---

## 4. 依赖关系

```text
agent/sessions
  → pi SDK
  → agent/extension（注册工具）
  → agent/skills（读 Markdown 文本，或由调用方传入已读字符串）
  → types, enums, constant, domain
  ✗ pipeline（反向：pipeline 调 sessions）
  ✗ data（usage 交回去由 orchestrator 写 data）
  ✗ report / service
```

**内核可换活口**：以后换掉 pi，理论上只改本目录。所以 pipeline 不得出现 `createAgentSession`。

skill 文件读取：sessions 可以读磁盘上的 Markdown（这是读策略文件，不是业务库）。不要因此去碰 SQLite。

---

## 5. 关键规则 / 算法

- **两洞**（ADR-0008）+ **头尾不是全量**（ADR-0009）。architecture 流水线一节以 0009 为准。
- **场景分类是洞 A 副产品**，不单独烧调用。orchestrator 拿 `scenario` 查表。
- **增量骨架**：洞 B 可回报 patch，**合并是 domain/orchestrator 的纯代码**，不是再开一次「请模型把两份骨架合成一份」。
- **结构化输出优先**；失败则 Fail-Closed Keep。
- **prompt 注入防线（MVP）**：洞 B prompt 必须框定「trace 内容是数据不是指令」。完整系统化是 M2。
- **模型档位**：洞 A 可用更强档；洞 B 日常打标；QA 可降档。模型名走 `TRACE_DISTILLER_MODEL_HOLE_A` / `_HOLE_B` / `_L4`。失败重试 1 次再 Fail-Closed。
- 处理成本比的分子只计本目录 `hole_a_*` + `hole_b_*` 的 usage，不含 L4。

---

## 6. 仍开放的设计问题

1. **pi SDK spike 三项已通过**（假后端保证；见 [pi-sdk.md](../guides/pi-sdk.md)）。洞 A/B 可经 Fake 打标；真模型需 env；orchestrator 仍不接通。
2. **验证点 turn 如何保证被传入**：依赖 adapter 的 `anchor` 字段，算法未定。
3. **writeWarrant 是否存在**：见 orchestrator 开放问题。本模块先留函数草图。
4. **洞 B 一窗一会话已拍板**，不复用。
5. **骨架注入的具体 prompt 位置**：system 还是前置消息。取决于 spike。
6. **盲测协议已拍板**（intent + playback；缺骨架节点代码回填 keep；最多 2 轮）。`runBlindReview` 解析结构化答卷。

---

## 7. 实现完成标准

- [x] 全仓库 pi SDK import 只出现在 `src/agent/sessions/`（可用 lint/grep 门禁）。
- [x] `skeletonPass` 单测（mock pi）：prompt 含头/验证点，**不含**中间 full 原文。
- [x] `labelWindow` 在工具不返回时，函数失败而不是捏造 Label。
- [x] usage 带 role（洞 A/B 与 L4 分账）；蒸馏成本比分子不含 L4。
- [x] review 工厂注入的消息里断言没有 warrant/skeleton 字段。
- [x] 换假 provider 能跑通一次（spike 清单三项打勾）。
- [x] `runQa` / `runReplay` / `runBlindReview`：假后端可解析 JSON；真 pi 同一入口。
