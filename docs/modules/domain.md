# domain — 纯决策模型

对应路径：`src/domain/`。architecture 点名：`LabelDecision` / `CutDecision` / `SpanViolation`。这里放**不变量与构造**，不放 IO。

types 是 JSON 形状；domain 是「这形状怎样才算合法、两个形状如何合成」。

---

## 1. 目的 / 非目标

**目的**

- 把打标结果、裁剪动作、够得着检查收成带不变量的对象，供 rules / assembler / eval 共用。
- 保证「规则层决定」和「洞 B 决定」能合成到同一条 LabelDecision，且来源不丢。

**非目标**

- 不读 SQLite、不读文件、不调 pi。
- 不执行裁剪（那是 assembler）。domain 只说「这条决定合不合法」。
- 不渲染报告。
- 不把 CutProfile 默认值放这里（那是 constant）。

---

## 2. 输入输出

纯函数 + 不可变对象。草图：

```ts
interface LabelDecision {
  segment_id: string
  label: Label
  source: WarrantSource        // rule | llm
  confidence: number           // 0–1
  /** 规则命中名，如 repeat_read；洞 B 可空 */
  rule_name?: string
  /** 文件依赖图送来的免费信号，供洞 B 当先验，不是最终标签 */
  graph_hints?: Array<'read_then_later_written'>
}

interface CutDecision {
  segment_id: string
  action: CutAction
  from_label: Label
  profile_id: string
  source: WarrantSource
  confidence: number
  dead_end_summary?: string
}

interface SpanViolation {
  id: string
  left_segment_id: string
  right_segment_id: string
  gap_segments: number
  reason: 'gap_too_large' | 'continuity_fail'
  /** 洞 B check_continuity 的分数，若请过 */
  continuity_score?: number
}

/** 规则已定标的段不再进洞 B */
function isResolvedByRules(d: LabelDecision): boolean

/** 窗输出解析失败 → 该段 keep，标签不做死胡同 */
function failClosedKeep(segment_id: string): CutDecision

/** Label + CutProfile → CutDecision；不读 IO */
function decideCut(label: LabelDecision, profile: CutProfile): CutDecision

/** 已 keep 的有序 id + 策略 → 违规列表 */
function checkSpan(keptIds: string[], allIds: string[], policy: SpanPolicy): SpanViolation[]

/** 若干窗对骨架的补丁，代码合并为 v1。冲突策略见开放问题 */
function mergeSkeleton(base: Skeleton, patches: SkeletonPatch[]): Skeleton
```

`SkeletonPatch` 由洞 B 窗回报，形状属于 types 或 domain 内部；合并算法必须确定性。

---

## 3. 职责与边界

**做**

- 不变量：Warrant 覆盖全部段；collapse 必须带摘要；keep/drop 禁止带摘要；confidence 范围；Fail-Closed 的 CutDecision 形状。
- Label → CutAction 的纯映射（吃 CutProfile）。
- Span 检查的纯计算（能用段数算的部分）。分数型连贯性仍由洞 B 提供数字，domain 只解释数字。

**禁止**

- `import` data / pi / fs / path。
- 在 domain 里选 skill、开窗口、重试。
- 用 LLM「修一下」SpanViolation——违规则 assembler 失败或回退，策略由 orchestrator 用纯代码选。

---

## 4. 依赖关系

```text
domain → types, enums, constant（阈值）
      ← pipeline/rules, pipeline/assembler, eval, data（序列化前后）
```

agent/sessions 产出的原始 JSON 应先经 domain 构造成 LabelDecision，再交给 assembler。不要让 assembler 直接吃洞 B 的松散 JSON。

---

## 5. 关键规则 / 算法

- **规则优先**（[ADR-0002](../adr/0002-rule-first-labeling.md)）：`isResolvedByRules` 为真的段，orchestrator 不得再送洞 B。洞 B 不得覆盖已决议的规则标签（除非以后 ADR 明确允许「规则改判」，当前不允许）。
- **保守不裁**（ADR-0008）：解析失败构造的 CutDecision.action 必须是 `keep`，source 记为规则名 `fail_closed_keep`。
- **够得着**（[ADR-0004](../adr/0004-span-constraint-reachable.md)）：压缩率下限不是越低越好。`checkSpan` 失败时 assembler 不得假装成功。
- **凭证引用**（ADR-0009）：CutDecision 不携带改写后的段正文。
- **盲测回填**：review 缺的是骨架节点对应的段，回填动作是把那些段的 CutDecision 改成 keep，再跑 assembler——这是纯代码，最多两轮。

---

## 6. 仍开放的设计问题

1. **骨架补丁冲突**：两个窗回报改同一节点，merge 是后来者胜、并集，还是标冲突走 Fail-Closed？文档没说。
2. **span 的定量定义**：段数 gap vs `check_continuity` 分数 vs 二者同时。domain 的 `SpanViolation.reason` 预留了两个，阈值在 constant，算法组合未拍板。
3. **规则与洞 B 对同一段都有输出**：当前设计是规则已决议则不进洞。若规则只给 `graph_hints` 不给最终 Label，LabelDecision 如何表示「未决」——要不要第五状态 `unresolved`？建议：**未决不写 LabelDecision**，用段 id 队列表示，避免第五标签。
4. **collapse 摘要谁写**：规则层的相似重试能否模板化摘要（「重复读 X 失败 N 次」）而不走 LLM？0009 说唯一改写口是这句话，没说必须 LLM 写。

---

## 7. 实现完成标准

- [ ] LabelDecision / CutDecision / SpanViolation 有单测覆盖不变量。
- [ ] `decideCut` 对四个 Label × 默认 profile 的映射有表驱动测试。
- [ ] `failClosedKeep` 永不返回 drop/collapse。
- [ ] `checkSpan` 不碰 IO，给定 id 列即可复现。
- [ ] domain 目录 grep 不到 `sqlite` / `@mariozechner/pi-agent` / `fs.`。
