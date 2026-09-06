# pipeline/assembler — 凭证执行与同源投影

对应路径：`src/pipeline/assembler.ts`。纯代码按 CutWarrant + CutProfile 做保留 / 一句压缩死胡同 / 删例行；**Span Constraint 在此强制**；产出 CutPlan，并投影 Training Cut / Playback Cut。

---

## 1. 目的 / 非目标

**目的**

- 执行凭证，不解释凭证。LLM 已经（或规则已经）说了 keep/collapse/drop，assembler 落地成剪后序列。
- 强制「够得着」（[ADR-0004](../adr/0004-span-constraint-reachable.md)）。不过则失败或走编排器选定的回退，**回退策略仍由纯代码决定**。
- 同一 CutPlan 投影两种产物（[ADR-0003](../adr/0003-dual-cut-outputs.md)）。禁止为好看再摘要一次。

**非目标**

- 不改标签、不重打标。
- 不自己 invent 删除理由。理由在 warrant 里。
- 不渲染 HTML（report 吃 PlaybackCut + warrant）。
- 不直接调 pi。需要衔接检查时，由 orchestrator 调洞 B，把分数放进 domain 再进来；或 assembler 依赖注入一个 `checkContinuity` 函数（实现指向 sessions）。assembler 文件本身不 import sessions 亦可——更干净的是 orchestrator 先补 continuity，assembler 只看 SpanViolation。

---

## 2. 输入输出

```ts
interface AssembleInput {
  raw: RawTrace
  view: AgentView
  warrant: CutWarrant
  profile: CutProfile
  /** 可选：洞 B 已打过的相邻对分数 */
  continuity?: Array<{ left: string; right: string; score: number; ok: boolean }>
}

interface AssembleOutput {
  plan: CutPlan
  training: TrainingCut     // M1 可先等于「按 plan 抽出的 RawTurn 列」
  playback: PlaybackCut
}

function assemble(input: AssembleInput): AssembleOutput
```

失败：span 无法在「不加回被删关键段」的情况下满足时，抛 `SpanFailure`，让 orchestrator 选回退（把缺口两侧之间的段改 keep，或插入更多 representative dead end）。assembler 不偷偷吞掉失败。

---

## 3. 职责与边界

**做**

- 校验 warrant 覆盖所有 segment id。
- `collapse` 用 `dead_end_summary` 生成占位卡片/占位 turn（这是唯一改写）。keep 段：Training 用 RawTrace 原文，Playback 用卡片。
- drop 段进 `plan.dropped`，报告可点开。
- 按 profile 再校验一遍：例如 label 是 routine 但 warrant 却 keep——以 warrant 为准还是以 profile 为准？见开放问题。建议：**warrant 已经是最终动作**，profile 应在写 warrant 之前用掉（domain.decideCut）。assembler 只执行。
- 计算剪后序列上的 gap，填 `span_ok` / `span_violations`。

**禁止**

- 改写 keep 段内容（包括「稍微缩短一下思考」）。
- 为 Playback「更像故事」而合并两段关键决策。
- 读 SQLite。
- 因为压缩率 > 30% 就再删一轮。压缩率是评测指标；不够短应回头改规则/profile/打标，而不是 assembler 私自加刀。

---

## 4. 依赖关系

```text
assembler → types, enums, constant, domain
         ← orchestrator
         ✗ pi / agent（除非注入，且建议不注入）
         ✗ data / report / adapters
```

---

## 5. 关键规则 / 算法

- **引用式执行**（ADR-0009）：输出序列 = 按原序挑 keep 原文 + collapse 一句。顺序不得重排。
- **够得着**：相邻 keep（collapse 占位算不算「步」，见开放问题）跨度不得超过策略。PRD：可用少量代表性死胡同填因果缺口，而不是只追求最短。
- **双产物同源**：`training.plan_ref === playback.plan_ref`。两边 keep 的 segment id 集合相同。Playback 可以少显示字段（卡片 vs 原文），不能少段。
- **M1 vs M2**：M1 允许只交一份中间剪后 Trace（其实就是 CutPlan + 一种投影）；M2 两种格式定型。assembler 从第一天就应返回同一 plan 的两种投影，哪怕 Training 格式还不是 SFT 模板。

回退策略（由 orchestrator 选择、assembler 提供纯函数支持）：

1. 把最近的 `dead_end` collapse 成代表性一句插入缺口；
2. 仍不够则把缺口内 `useful_exploration` 改 keep；
3. 禁止为过 span 而丢掉 `key_decision`。

---

## 6. 仍开放的设计问题

1. **span 定量**（与 domain/constant 同一题）：段数？token？`check_continuity` 分数下限？ADR-0004 没有可执行数字。
2. **collapse 占位在 Training Cut 里长什么样**：一句 user/assistant 旁白，还是一条特殊 role？SFT 格式未定（M2）。
3. **warrant 与 profile 冲突**谁赢。上文建议 warrant 赢。
4. **连续性检查何时调用**：每对相邻 keep 都问洞 B，还是仅 gap 超过阈值的对？成本差一个数量级。architecture 说「必要时」。
5. **token 口径**再次出现：assembler 不负责定义，但 `span` 若按 token 算，它必须用同一口径。

---

## 7. 实现完成标准

- [ ] 同源：两种投影的 segment id 集合相等，有单测。
- [ ] keep 段 Training 投影与 RawTrace 对应 turn 字节级一致（不含 collapse）。
- [ ] drop 段绝不出现在投影正文，但 id 留在 plan.dropped。
- [ ] span 失败抛错，不返回 `span_ok: true` 的脏 plan。
- [ ] 无 pi、无 sqlite、无 HTML。
