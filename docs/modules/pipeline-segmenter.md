# pipeline/segmenter — L1 切段

对应路径：`src/pipeline/segmenter.ts`。按 Action Unit 把 RawTrace 切成 Segment，并**纯代码**生成 AgentView 卡片上那些非意图字段。

---

## 1. 目的 / 非目标

**目的**

- 切段：一次思考 + 一次工具调用 + 返回 = 一段（PRD §4.1，CONTEXT：Action Unit）。
- 抽出卡片原料：`id` / `tool` / `reads` / `writes` / `tokens` / `head` / `raw_refs`。`sig`、`rep_of`、`focus` 若规则可算，也在这一层用纯代码填；填不了的留给 rules。
- 产出的是 AgentView 的 `segments` 骨架，**不含**意图、不含四类标签。

**非目标**

- 不打四类标签（rules / 洞 B）。
- 不跑 Admission Gate（adapters 已经做过）。无 GT 的东西走不到这里。
- 不调 LLM 写 `head`。`head` 是原文截首句/首行。
- 不决定 keep/drop。
- 不把多个任务再切一次——那是 adapter。segmenter 假设输入已是单任务 RawTrace。

---

## 2. 输入输出

```ts
interface SegmenterInput {
  raw: RawTrace
}

interface SegmenterOutput {
  /** 尚未填 intent / skeleton；meta 从 RawTrace 拷贝 */
  view: AgentView
}

function segment(input: SegmenterInput): SegmenterOutput
```

`AgentView.intent_hypothesis` / `skeleton` 在切段结束时可以是空壳（version 0 占位）。洞 A 之后再写。不要让 segmenter 伪造意图文案。

每张 SegmentCard 在这一步至少有：`id`、`tool`、`outcome`（若能从返回码看出来）、`reads`、`writes`、`tokens`、`head`、`raw_refs`、默认 `focus: 'card'`。`sig` / `rep_of` 见开放问题——建议 **sig 在 segmenter 生成，rep_of 在 rules 聚类后回填**。

---

## 3. 职责与边界

**做**

- 定义段边界。工具调用与返回必须落在同一段；连续纯思考如何切，见开放问题。
- 从工具参数/返回里抽 `reads` / `writes` 路径（字符串列表，供规则层画依赖图）。
- 稳定段 id（例如 `s0001` 按序，或基于 raw_refs 哈希）。同一 RawTrace 切两次 id 相同。

**禁止**

- `import` pi、data、report。
- 读取 CutProfile 来「少切一点」——切段粒度不由压缩率目标反推（architecture：LLM/配置不得决定切段粒度）。
- 丢弃原文。卡片只是投影，RawTrace 由 orchestrator 另行交给 data 保存。

---

## 4. 依赖关系

```text
segmenter → types, enums, utils（token 估算）
         ← orchestrator
         ✗ data / agent / assembler / rules（单向：rules 吃 segmenter 的输出，segmenter 不调 rules）
```

文件依赖图的**边**在 rules 里连；segmenter 只负责节点上的 reads/writes 数组。

---

## 5. 关键规则 / 算法

- **Action Unit = 思考 + 工具 + 返回**。这是切段的产品定义，不是按 token 窗口切。
- **卡片字段零 LLM**（ADR-0009）。`head` 截取规则：原文第一行，超过 `SEGMENT_HEAD_MAX_CHARS`（已拍板 120）截断。
- **focus 默认 card**：降为 `line` 是 rules 的事（噪音段）；升为 `full` 是洞 B 调 `read_segment` 的事。
- 切多少段是确定性函数，必须可复现，否则 benchmark 数字漂。

---

## 6. 仍开放的设计问题

1. **`sig` 生成规则（P0）**：同质动作的键。候选：`tool + 归一化路径`，或再加参数骨架（去掉行号/UUID）。不定这个，rules 的相似重试聚类没法写。
2. **没有工具调用的纯思考轮**：单独成段，还是并入下一次工具？PRD 写的是「思考+工具+返回」，纯思考是缺口。
3. **一次思考里连续两次工具调用**：一段还是两段？建议两次工具 = 两段，思考挂在第一段或按原文归属。
4. **reads/writes 抽取**：各工具名（Read/Edit/Bash）的路径解析是 adapter 的规范化字段，还是 segmenter 认工具名？建议 adapter 尽量保留原始工具名，segmenter 内建一张工具→读写的确定性表，未知工具则读写为空。
5. **token 口径（P0）**：段上 `tokens` 含不含工具输出全文，直接决定压缩率。

---

## 7. 实现完成标准

- [ ] 给定夹具 RawTrace，切出的段数、id、raw_refs 稳定。
- [ ] 每段都能指回 RawTrace 原文，Training Cut 投影不丢字。
- [ ] `head` 测试断言等于原文截取，不是「摘要」。
- [ ] 无 pi、无 sqlite。
- [ ] `sig` 规则关闭之前，允许输出空 `sig` 并在文档标明阻塞 rules 聚类；关闭之后单测锁定若干同质/异质对。
