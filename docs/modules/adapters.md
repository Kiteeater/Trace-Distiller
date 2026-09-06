# adapters — L0 适配器

对应路径：`src/adapters/`。各格式 parser → 规范 [RawTrace](./types.md)。只解析对齐，不做打标、不剪辑。

---

## 1. 目的 / 非目标

**目的**

- 把 Claude Code / pi session / SWE-bench 等原文，收成同一份 RawTrace。
- 执行 **Admission Gate**：没有 Ground Truth 的输入当场拒绝，不进 SQLite，不进流水线（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）。
- 把「一条 session」切成「一条任务 = 一条 Trace」（策略未拍板，见开放问题）。

**非目标**

- 不打标签、不切 Action Unit（切段是 segmenter）。adapter 最多识别 turn 边界，方便下游切。
- 不生成 AgentView / 卡片 / `sig` / `head`。
- 不分析失败 Trace。失败的、无验证的，拒绝即可，不写「失败原因报告」。
- 不调 LLM 判断「这算不算成功」。成功必须是原料自带的可验证标记。

---

## 2. 输入输出

```ts
interface Adapter {
  source: TraceSource
  /** 能认的文件/对象就解析；认不出抛错，不要返回空 Trace */
  sniff(input: unknown): boolean
  parse(input: unknown): RawTrace   // 失败或无 GT：抛 AdmissionError
}

interface AdmissionError {
  code: 'no_ground_truth' | 'unparseable' | 'multi_task_ambiguous'
  message: string
}

/** 编排器侧：按 source 或 sniff 选 adapter */
function loadRawTrace(path: string, source?: TraceSource): RawTrace
```

输入：磁盘上的 session JSON / JSONL、SWE-bench 产物包。  
输出：一份带 `ground_truth` 的 `RawTrace`。  
副作用：无。入库是 orchestrator 调 `data/` 做的，adapter 不写库。

MVP 优先级（TODO / milestones）：**claude-code JSONL 先做**；pi session、SWE-bench 随后。openclaw 若与 Claude Code 同构，可复用同一 parser。

---

## 3. 职责与边界

**做**

- 字段对齐：思考、工具名、参数、返回、token 计数（按当时已拍板的口径；口径未定则先原样记录，压缩率统计暂标 UNKNOWN）。
- 抽出 `ground_truth.evidence_ref`（测试通过日志、SWE-bench resolved 标记等）。
- 填 `TraceMeta.source` / `trace_id`（id 生成规则：原料自带 id，否则确定性哈希，禁止随机 UUID 导致评测对不上）。

**禁止**

- 调用 `agent/sessions` 或任何 LLM。
- 直接写 SQLite。
- 「看起来像成功」就放行。
- 在 adapter 里做相似重试聚类、文件依赖图——那是 L1。

---

## 4. 依赖关系

```text
adapters → types, enums, utils（jsonl 读、token 估算——若口径已定）
        ← orchestrator 调用
        ✗ data（不写库）
        ✗ agent / pi
        ✗ pipeline/rules
```

---

## 5. 关键规则 / 算法

- **Admission Gate**（ADR-0001）：无 Ground Truth → 拒绝。这是训练数据质量的生命线，也是「失败 Trace 不分析」的产品边界。
- **一条 Trace = 一个任务**：意图推断和切段都假设任务单一。session 里修 bug 顺带重构，必须先切。切分算法未定，见开放问题。
- **验证点不是死板末尾**（ADR-0009）：agent 干完正事常还有写文档/清理/闲聊。adapter 应尽量标出 GT 证据所在 turn id，供洞 A 当硬锚点；找不到则标记缺失，不要假装最后一轮就是验证点。
- 解析失败与无 GT 要区分错误码，CLI 才能给出人话。

---

## 6. 仍开放的设计问题

1. **多任务 session 切分（P0）**：按 user 新指令？按 git commit？按测试套件切换？切错会污染骨架。**adapter 没法在这题拍板前写完。**
2. **Ground Truth 在 Claude Code session 里的具体形状**：测试命令输出？用户说「好了」？现有文档只有原则。
3. **验证点定位算法**（TODO P0）：从 trace 找 GT 附近 turn。头 1–2 turn + 验证点附近，是洞 A 的输入；谁负责切出这几段——adapter 打标，还是 sessions 自己从头扫？建议 adapter 产出 `anchor_turn_ids`，sessions 只读这些 id。
4. **trace_id 稳定性**：同一文件跑两次 id 必须相同，否则 SQLite 评测对不上。
5. **SWE-bench 包结构**本仓库还没有样例，parser 细节无法从现有文档写出。

---

## 7. 实现完成标准

- [ ] 无 GT 的夹具被拒绝，单测断言错误码 `no_ground_truth`。
- [ ] 有 GT 的 claude-code JSONL 能得到 RawTrace，且 `turns` 能还原工具调用顺序。
- [ ] adapter 源码无 pi、无 sqlite。
- [ ] 同一输入两次 `parse` 得到同一 `trace_id`。
- [ ] 多任务切分策略有 ADR 或 TODO 关闭记录后，才宣称 adapter 完成；在此之前只接受「已经是单任务」的原料，碰到疑似多任务返回 `multi_task_ambiguous`。
