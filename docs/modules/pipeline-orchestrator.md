# pipeline/orchestrator — 确定性编排

对应路径：`src/pipeline/orchestrator.ts`。整条 Distiller 的控制流。**内部不调用 LLM、不 import pi。** 需要判断力时只调用 `agent/sessions` 的两个洞。

这不是 agent，也不是 LangChain 图。就是一段 TypeScript 函数。

---

## 1. 目的 / 非目标

**目的**

- 按固定顺序跑完：准入后的 RawTrace → 切段 → 洞 A → cut-brain（可选 `apply_rules_hint`）→ 凭证 → assembler →（可选）盲测回填 → 交给 service 去导出/出报告。
- 决定：切多少窗、失败怎么重试、何时 Fail-Closed Keep、review 回填哪几段。这些全是代码。
- 查 `SKILL_ROUTE`，把 skill 路径传给洞 B，不让 LLM 选策略文件。

**非目标**

- 不在本文件里写 parser、规则细节、HTML、SQL。
- 不引入编排框架。
- 不让 LLM 决定步骤顺序或切段粒度（architecture「明确不做」）。
- 不把重放成功率塞进每个打标窗（太贵，属 L4）。

---

## 2. 输入输出

洞流程以 ADR-0009 的五步为准；分层上 ④ 是 assembler，⑤ 是 eval。orchestrator 负责把它们串起来。

```text
① 洞 A skeletonPass：头 1–2 turn + 验证点附近 → 意图 v0 + 场景码 + 骨架 v0
② cut-brain（洞 B 角色）：agent 可调 `apply_rules_hint`；未决 `label_segment` / `keep_segment`；工具结果 mask 后迭代
③ 凭证：基于骨架 v1 + 全部 LabelDecision 写出 CutWarrant
     （建议：洞 A 二次调用 writeWarrant；若实现选择纯代码汇总，也必须仍走本步骤的数据形状）
④ assembler：执行凭证 + span；必要时洞 B check_continuity
⑤ eval.review：只给意图 + 剪后 trace；缺失骨架点则代码回填 keep，最多两轮
```

```ts
interface DistillInput {
  raw: RawTrace                 // 已过 Admission Gate
  profile: CutProfile
  mode: 'no_llm' | 'with_llm'
  opts?: { sessionBackend?: SessionBackend }
}

interface DistillResult {
  raw: RawTrace
  view: AgentView               // 含最终 intent / skeleton
  warrant: CutWarrant
  plan: CutPlan
  training?: TrainingCut        // M1 可空，先给 plan
  playback?: PlaybackCut
  metrics_ref: string           // data 层指标行
}

function distill(input: DistillInput): Promise<DistillResult>
```

orchestrator 是 async 的唯一原因：洞 A/B 是 IO。它自己的分支逻辑仍是确定性的。

---

## 3. 职责与边界

**做**

- 调 adapters 之外的 biz 函数（adapter 也可由 service 先调再传入；两种都可以，但 GT 检查必须已发生）。
- 不把 `applyRules` 静默并进最终 decisions；规则仅当 cut-brain 调用 `apply_rules_hint`。
- cut-brain 内部按 `LABEL_WINDOW_SIZE` / `CUT_BRAIN_MAX_ROUNDS` 迭代未决 id。
- 窗失败：解析失败或超 token → 该窗 `failClosedKeep`，记入 warrant source=`fail_closed_keep`。
- 场景码 → skill：查表，查不到按 constant 规定失败或默认 skill。
- review 回填循环：最多 `REVIEW_MAX_ROUNDS`；回填名单来自「骨架节点 ∩ 被 drop/collapse 的段」，不是 LLM 指定。

**禁止**

- `import` pi SDK。
- 直接 `sqlite3` / 写文件（打标落库走 `data/`）。
- 第三洞：不要 `createAgentSession('judge')`。review / 重放走 sessions 工厂 + `AgentRole.l4_*`。
- 在 orchestrator 里拼打标 prompt。prompt 在 skill 文件与 extension。

---

## 4. 依赖关系

```text
orchestrator
  → pipeline/segmenter, pipeline/rules, pipeline/assembler
  → agent/sessions     （唯一 LLM 出口）
  → domain, types, enums, constant
  → data               （读写段队、标签、凭证、指标）
  ✗ pi
  ✗ report / service（反向：service 调 orchestrator）
  ✗ utils 里的有状态东西（不许存在）
```

eval：M1 的盲测回填由 orchestrator 调 `eval` 的 review 函数；日常 QA/重放也可以是 CLI 另一条子命令，不阻塞 `distill()`。建议 `distill()` 内只做 ⑤ 的回填循环（它会改 CutPlan），完整 benchmark 另跑。

---

## 5. 关键规则 / 算法

- **编排不用 LLM**（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。benchmark 要可复现。
- **洞 A 不是全量读**（ADR-0009 覆盖 architecture 旧表述）：只插头尾 + 验证点；骨架靠窗回报增量修。
- **map-reduce 在编排器**，不必改 pi：读 data 段队 → 逐窗 `labelWindow` → 骨架注入每窗 context。
- **Fail-Closed Keep**（ADR-0008）：宁多勿漏，对齐关键步召回。
- **预算分账**（ADR-0007）：sessions 调用必须带 `AgentRole`，成本数字才能进报告首页。
- **凭证由代码执行**（ADR-0009）：即使 ③ 用了洞 A 写 JSON，④ 仍是 assembler 纯代码。LLM 不能 `edit_trace`。
- 跳过洞的 MVP 通路（architecture 落地顺序第 3 步）：规则全覆盖或 `--no-llm` 时，orchestrator 仍能导出保守 CutPlan（未决全 keep），用于先打通压缩率统计。

③ 写凭证放哪：architecture 只导出 `skeletonPass` / `labelWindow` 两个函数。本设计建议：

- 对外仍只有两个洞；
- `writeWarrant` 若需要 LLM，作为 **洞 A 会话的第二次调用**，实现放在 `agent/sessions` 内部，orchestrator 只调 `sessions.writeWarrant(...)` 或 `skeletonPass` 的 phase-2。
- 若后续 ADR 改为纯代码从 LabelDecision + profile 生成 warrant，orchestrator 改一行即可，assembler 不变。

---

## 6. 仍开放的设计问题

1. **③ 到底要不要 LLM**：0009 写「主 agent 写 JSON 凭证」；architecture 写重组纯代码。本文件给了兼容建议，**未在 ADR 层关闭**。
2. **窗并行**：确定性 merge 如何定义顺序。
3. **洞 A 二次调用的输入有多大**：骨架 v1 + 每段标签可能仍然很长——是否只传卡片 line 级 + 标签列？0009 未规定。
4. **跳过洞 A 的 MVP**：milestones 允许「排期紧可先无骨架打通」。orchestrator 是否正式支持 `skeleton=empty` 仍跑洞 B？建议支持，但 skill 路由要有 default。
5. **review 失败后的产品行为**：两轮回填仍盲测不及格，是 DistillResult 带 `review_failed` 继续出报告，还是进程非零退出？门禁是 M2 的事，M1 要书面结论即可。

---

## 7. 实现完成标准

- [x] 源码 grep 不到 pi SDK。
- [x] `--no-llm`（或测试注入假 sessions）能从 RawTrace 跑到 CutPlan。
- [x] 窗解析失败夹具 → 该窗段全部 keep，且 warrant source 可查。
- [x] 场景码路由有单测。
- [x] review 回填最多两次，第三次不会发生。
- [x] 同输入同 profile 两次 `distill`，在 mock 掉 LLM 后 CutPlan 字节级一致。
