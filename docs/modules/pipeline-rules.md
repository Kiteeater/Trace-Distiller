# pipeline/rules — L1 规则层

对应路径：`src/pipeline/rules.ts`。失败调用、重复读、相似重试等，能定的尽量在进洞之前定完（[ADR-0002](../adr/0002-rule-first-labeling.md)）。

---

## 1. 目的 / 非目标

**目的**

- 用确定性规则给段打四类标签里**能打的那些**，写出 LabelDecision。
- 相似重试聚类（TODO：token Jaccard），回填 `rep_of`。
- 文件依赖图：reads/writes 连边；「读过的文件后来被改过」→ `graph_hints`，给洞 B 当免费置信度，不是替洞 B 做完判断。
- 按规则集把噪音段的 `focus` 降为 `line`。

**非目标**

- 不判断「这段探索有没有价值」这种模糊题——那是洞 B。
- 不调 LLM。规则吃不准就**留未决**，把段 id 交给 orchestrator 排进洞 B 队列。
- 不执行裁剪、不写 CutWarrant 的最终动作（可以建议，但 warrant 在打标全部完成后由洞 A 二次调用或纯代码汇总，见 orchestrator）。
- 不覆盖即将到来的洞 B 结果——规则先跑，已决议的段洞 B 根本看不到。

---

## 2. 输入输出

```ts
interface RulesInput {
  view: AgentView          // segmenter 产出，intent 可仍为空
  raw: RawTrace            // 仅当规则需要 outcome 原文；能只用卡片就只用卡片
}

interface RulesOutput {
  view: AgentView          // 回填 rep_of、focus、（可选）sig 规范化
  decisions: LabelDecision[]   // 仅已决议段
  unresolved_ids: string[]     // 进洞 B
  graph: FileDepGraph
}

interface FileDepGraph {
  nodes: string[]          // 路径
  /** 读边 / 写边，带 segment id */
  edges: Array<{ path: string; segment_id: string; op: 'read' | 'write' }>
}

function applyRules(input: RulesInput): RulesOutput
```

---

## 3. 职责与边界

**做**

- 规则目录（MVP 至少）：
  1. 失败工具调用且后续无新信息 → 倾向 `dead_end` 或进入聚类。
  2. 重复读同一文件、无中间 write → `routine`。
  3. 相似报错重试（Jaccard）→ 聚到 `rep_of`，代表段未决或 `dead_end`，其余 `line` + `routine`/`dead_end`。
  4. 读过的路径后来被 write → 给该读段 `graph_hints: ['read_then_later_written']`，**默认仍未决**（这是有效探索强信号，不是自动 key_decision）。
- 已决议段 `focus='line'`（噪音）；未决默认 `card`。
- 每条 LabelDecision 必须带 `rule_name`，报告「点开删除理由」靠它。

**禁止**

- 调用洞 A/B。
- 因为压缩率还不够就多删——规则不看压缩率目标。
- 把未决段标成 `routine` 凑覆盖率。宁少标，勿错杀关键决策（召回优先）。
- 直接写 SQLite（orchestrator / data 来记「规则覆盖了多少段」）。

---

## 4. 依赖关系

```text
rules → types, enums, constant（Jaccard 阈值等）, domain, utils
     ← orchestrator（在 segmenter 之后、洞 B 之前）
     ✗ agent / pi / data / assembler
```

---

## 5. 关键规则 / 算法

- **规则优先，LLM 只打模糊段**（ADR-0002）。成本卖点依赖这一层真的吃掉大部分段；0009 粗账是规则清完约剩 30% 进 LLM。
- **召回优先**：错标 `key_decision` 为 `routine` 会直接打穿关键步召回（benchmark 最硬指标）。不确定 → `unresolved_ids`。
- **聚类粒度取决于 `sig`**。sig 未定，本模块的 Jaccard 只能先按 TODO 写「token Jaccard」，键空间开放。
- **注意力默认档由代码决定**（ADR-0009）：本模块是默认档规则集的实现处。
- 规则名稳定：报告、SQLite、凭证 `source.name` 三处同一字符串。

建议的规则名（实现时可增，改名要迁数据）：

| rule_name | 典型 Label | focus |
|-----------|------------|-------|
| `failed_call_no_followup` | dead_end | line |
| `repeat_read` | routine | line |
| `similar_retry` | dead_end / routine | line |
| `read_then_later_written` | （hint，未决） | card |

---

## 6. 仍开放的设计问题

1. **注意力档规则集（P0）**：除「已决议噪音 → line」外，什么情况默认 `full`？几乎不应默认 full（拉取式，不是推送式）。是否 MVP 从不默认 full？
2. **Jaccard 阈值已拍板 0.8**。文本取自 tool_result 原文（缺则卡片 head）。token 计数库选型仍 OPEN。
3. **失败调用一定是死胡同吗**？第一次失败但引出关键决策的，应是有效探索。规则如何避免误杀：建议失败且「后续无写入/无新 sig」才标死胡同，否则未决。
4. **`sig` 未定**时聚类实现应阻塞。

---

## 7. 实现完成标准

- [ ] 夹具：重复读、相似报错重试、干净的关键编辑，规则输出与预期表一致。
- [ ] 未决段不含已决议 id；已决议段不出现在 `unresolved_ids`。
- [ ] 每条决策有 `rule_name`；无匿名规则。
- [ ] 无 pi、无 sqlite。
- [ ] 规则覆盖率可从 `decisions.length / segments.length` 算出，供 data/eval/报告使用。
