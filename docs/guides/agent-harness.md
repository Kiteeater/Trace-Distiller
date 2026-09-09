# Agent system harness

| 字段 | 内容 |
|------|------|
| 版本 | v0.1 |
| 日期 | 2026-09-07 |
| 状态 | 确认「流水线里嵌两个洞」；不是 Distiller Runtime Agent |
| 权威来源 | [ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)、[ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md)、[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)、[agent-sessions.md](../modules/agent-sessions.md)、[pipeline-orchestrator.md](../modules/pipeline-orchestrator.md) |

## 目的

说清 **Agent system harness 是什么**：确定性 TypeScript 流水线里留两个插槽，插槽里才跑 pi 会话。它不是「一个 Distiller Agent 把整条链路编排起来」，也不是旧方案里那个单一 runtime。

读完应能回答：谁在编排、洞里有几个函数、失败怎么办、钱记在谁头上、skill 谁来选。

## 读者

- 写 orchestrator / sessions 的人。
- 把本仓库误认成「再做一个 coding agent」的人——先读「已定结论」。
- 对成本数字和 Fail-Closed 要负责任的人。

## 已定结论

**Harness = 流水线 + 两个 agent 洞。** 编排器不用 agent 框架、不用 LLM。只有判断力不够用的两处才嵌入 pi（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。产品词见 [CONTEXT.md](../../CONTEXT.md)：Agent 洞，Avoid「Distiller Agent」。

公开函数两个，都在 `src/agent/sessions/`（architecture 内核节；契约 [agent-sessions.md](../modules/agent-sessions.md)）：

```text
skeletonPass(...)    → 意图 + 骨架 + 场景分类     【洞 A】
labelWindow(...)     → 四类标签 + 置信度           【洞 B】
```

建议再导出一个同目录函数，**不是第三洞**：

```text
writeWarrant(...)    → CutWarrant JSON              【洞 A 角色的第二次调用】
```

0009 第 ③ 步需要引用式凭证；architecture 对外仍只承认两个洞。`writeWarrant` 若存在，预算记入 `hole_a_skeleton`。若以后改成纯代码从 LabelDecision + CutProfile 汇总，删掉该函数即可，orchestrator 已把这步隔离。

其余已定：

| 点 | 结论 |
|----|------|
| 洞 A 读什么 | **不是全量 Trace**。头 1–2 turn + 验证点附近，约 2k token 一次调用（[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md) 覆盖 architecture 旧「对整条抽骨架」） |
| 场景码 | 洞 A 副产品，不单独烧调用。orchestrator 查 `SKILL_ROUTE`，**模型不选 skill 文件** |
| 洞 B | 未决段 map-reduce 逐窗；骨架注入每窗 context；窗可回报骨架补丁，**合并是纯代码** |
| 衔接检查 | 复用洞 B 会话 / `check_continuity`，不是新洞 |
| 失败 | 解析失败或超 token → **Fail-Closed Keep**（该窗全保留，宁多勿漏） |
| 预算 | 三类会话分账（[ADR-0007](../adr/0007-separate-brain-label-judge-budgets.md)）：洞 A / 洞 B / L4。处理成本比只计 A+B |
| L4 | QA / 重放 / 盲测 review 走 sessions **工厂**，`AgentRole.l4_*`。干净会话，不算第三洞 |
| 裁剪权 | LLM 只出结构化判断；keep/collapse/drop 由代码执行凭证（0009） |

### 与旧「单一 runtime」的关系

[ADR-0006](../adr/0006-agent-orchestration-deterministic-tools.md) 假设 Distiller 是自主 Agent 运行时，编排权在 Agent 里（ScriptedPolicy / AgentPolicy，Brain/Label/Judge 三端口共一个 runtime）。**已被 0008 取代，不再作为现行决策。**

留下来的只有 0007 的分账原则：三类预算不能混。附着点从「一个 runtime 里的三个端口」改成「骨架 pass / 打标窗 / 评测重放」三类 pi 会话。architecture「与旧方案的关系」表就是这张对照。

不要在 `src/` 里复活 `runtime/`、`BrainPort`、编排 agent。

## 怎么用 / 怎么跑

Harness 的调用方是 `pipeline/orchestrator.distill`，不是 pi。sessions 像普通 async 函数；开会话、挂工具、注入 skill，是 sessions 内部的事。pi 怎么包见 [pi-sdk.md](./pi-sdk.md)。

### 一次 `distill` 里洞怎么被叫

```text
① skeletonPass          洞 A：意图 v0 + 场景码 + 骨架 v0
   orchestrator 查 SKILL_ROUTE(scenario) → skill_path
② 对 unresolved_ids 按 LABEL_WINDOW_SIZE 切窗
   每窗 labelWindow     洞 B：标签 + 可选 skeleton_patch
   代码 merge 补丁 → 骨架 v1
   窗失败 → failClosedKeep（source 可查）
③ writeWarrant（建议）  仍是洞 A 角色；或纯代码汇总，形状不变
④ assembler             纯代码执行凭证 + span
   必要时 checkContinuityPair（洞 B，不是新洞）
⑤ eval.blindReview      l4_review 干净会话；缺骨架点则代码回填 keep，最多两轮
```

规则已决议的段 **不进洞 B**。规则优先（[ADR-0002](../adr/0002-rule-first-labeling.md)）。

### 三个函数各自干什么

**`skeletonPass`** — 洞 A。输入是 adapter 标出的 `head_turn_ids` / `verification_turn_ids` 加上卡片流，不是 `raw.turns` 全量。禁止 sessions 擅自改读全量。输出带 `usage`，科目 `hole_a_skeleton`。

**`labelWindow`** — 洞 B。输入一段 id 列表 + 当前骨架 + 意图 + **调用方已经查好的** `skill_path`。原文不预塞；模型对某段没把握才调 `read_segment`。答案必须经工具 `label_segment` 落地成 `LabelDecision`；没调工具就结束 → 函数失败，交给编排器 Keep，禁止在洞里猜一个标签。

**`writeWarrant`（建议）** — 骨架 v1 + 全部标签 + CutProfile → 覆盖每一段 id 的 keep/collapse/drop。引用式：不改写 keep 段正文；死胡同一句话是唯一改写口。orchestrator 只调函数，不在编排器里拼凭证 prompt。

### skill 路由

```text
洞 A.scenario  →  constant.SKILL_ROUTE  →  skills/*.md  →  注入洞 B
```

查不到：硬失败或回退默认 skill，行为要有单测；禁止静默空 prompt（[constant.md](../modules/constant.md)）。skill 管「这类任务怎么打标」，CutProfile 管保留策略 / 压缩率 / span，两者正交。MVP 先 `_shared.md` + 已批准场景；名单未拍板前不要用三个随意文件名冒充完成。

### map-reduce 逐窗

超长 Trace 不硬塞（PRD 坑 1）。编排器读 data 段队，按窗调用 `labelWindow`。architecture 写逐窗 `createAgentSession()`；模块建议 MVP **一窗一会话**（贵但干净）。多窗复用同一会话能省，但有状态泄漏，未拍板。

并行：可以有限并行，但 merge 必须确定性。建议先串行。补丁合并是 domain/orchestrator 的纯代码，**不要再开一次「请模型把两份骨架合成一份」**。

### Fail-Closed Keep

窗口解析失败、超 token、或模型没交出合法 `label_segment`：该窗段全部 keep，warrant source 记 `fail_closed_keep`（或等价可查询标记）。对齐关键步召回：宁多勿漏。

禁止：失败当死胡同删掉、静默跳过、在洞里填一个默认 Label。`FAIL_CLOSED_KEEP = true` 在 MVP 不许改成 false——要改先改 ADR-0008。

`--no-llm` / 假 sessions：未决段同样全 keep，用于先打通压缩率统计（architecture 落地顺序第 3 步）。这仍是 harness，只是洞被短路。

### 预算分账（ADR-0007）

| AgentRole | 谁在用 | 进处理成本比？ |
|-----------|--------|----------------|
| `hole_a_skeleton` | 洞 A 头尾意图、骨架；含建议的 `writeWarrant` | 是 |
| `hole_b_label` | 逐窗打标 + `check_continuity` | 是 |
| `l4_qa` / `l4_replay` / `l4_review` | 评测 | **否** |

混用同一配额会出现「骨架吃光预算导致打标退化」或「评测烧费算进蒸馏成本」。报告首页「LLM 只看了 X%」和成本比，数字从 SQLite `usage` 按 role 聚合，禁止口头估。

盲测 review **故意不给** CutWarrant 和骨架（0009 §4）。回填名单来自「骨架节点 ∩ 被 drop/collapse 的段」，由代码算，不是 review 模型点名。

### 现在怎么跑

实现未开始。对照契约写 sessions + orchestrator 时：

1. 先打通 `--no-llm`：L0→L1→保守 CutPlan，harness 形状在、洞为空。
2. mock pi 跑 `skeletonPass` / `labelWindow` 单测（prompt 不含中间 full 原文；工具不返回则失败）。
3. 夹具：一窗 JSON 坏掉 → 该窗 keep 且 source 可查。
4. 真 pi 接上之前必须做 P0 spike，见 [pi-sdk.md](./pi-sdk.md)。

命令入口仍是 `script/run-distill.ts`；编排顺序不写在 CLI 里。

## 边界（非目标）

- 不是 Distiller Runtime Agent，不编排流水线步骤，不决定切段粒度。
- 不引入 LangChain / CrewAI / 第三个判断力工具。`read_segment` 是确定性取数，不是判断力。
- sessions 不跑 segmenter/rules/assembler，不写 SQLite，不渲染 HTML。
- 不把重放成功率塞进每个打标窗（太贵，属 L4）。
- 不做实时干预、不分析失败 Trace。
- 不让洞 B 直接输出 keep/drop——那是凭证 / profile。洞 B 只打四类 Label。

## 开放问题

1. **`writeWarrant` 是否走 LLM**：0009 写「主 agent 写 JSON 凭证」；architecture 写重组纯代码。orchestrator 给了兼容建议，**未在 ADR 层关闭**。
2. **一窗一会话 vs 复用会话**（[agent-sessions.md](../modules/agent-sessions.md) §6）。建议 MVP 一窗一会话。
3. **窗并行与确定性 merge 顺序**。
4. **跳过洞 A**：milestones 允许排期紧先无骨架打通。`skeleton=empty` 仍跑洞 B 需要 default skill。
5. **`LABEL_WINDOW_SIZE`** 数字未定（constant OPEN）。
6. **`read_segment` 挂成 pi tool 还是 prompt 外 RPC**：与 architecture「判断力工具只有两个」的字面冲突，模块已定义为非判断力工具，ADR 未关。
7. 验证点 turn 如何保证传入、review 结构化答卷格式：P0，sessions 实现不了猜。

## 完成标准

对照 [agent-sessions.md](../modules/agent-sessions.md) §7 与 [pipeline-orchestrator.md](../modules/pipeline-orchestrator.md) §7，harness 视角收成：

- [ ] 全仓库判断力 LLM 只出现在洞 A / 洞 B；orchestrator 源码 grep 不到 pi SDK。
- [ ] 对外仍是两个洞；若有 `writeWarrant`，role 是 `hole_a_skeleton`，不是第三洞。
- [ ] 场景码 → skill 路由有单测；模型选文件的路径不存在。
- [ ] 窗失败夹具 → Fail-Closed Keep，warrant 可查。
- [ ] usage 带 role；成本比不含 `l4_*`。
- [ ] review 工厂注入的消息里没有 warrant/skeleton。
- [ ] `--no-llm` 能从 RawTrace 跑到 CutPlan。
- [ ] 同输入同 profile，mock 掉 LLM 后 CutPlan 字节级一致。
