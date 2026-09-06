# data — SQLite

对应路径：`src/data/`。打标结果、凭证、评测指标的唯一落盘处。**biz（pipeline / agent）不直接碰库**，只调本目录导出的函数。

运行时大文件（原料 JSON、产物）仍按仓库 `data/raw`、`data/distilled` 约定；SQLite 管的是**可查询的表**，不是替代 JSONL。

---

## 1. 目的 / 非目标

**目的**

- 段队、标签、凭证、token 用量、规则覆盖率可查询——报告首页「LLM 只看了 X%」从这里来。
- 评测闭环：同一 `trace_id` 能把 Raw 路径、CutPlan、六项指标对上。
- 零运维单文件（architecture 选型）。

**非目标**

- 不是业务规则引擎。不在 SQL 里打标签。
- 不是展示层。
- 不存模型权重、不缓存 LLM 全文日志（用量数字 + 结构化决策即可；调试用的原始 completion 若存，须可关）。
- 不引入 Mongo / Postgres。macaron 的 data/Mongo 对应到这里就是 SQLite。

---

## 2. 输入输出

TODO P0 要求四类表：**段表 / 打标表 / 凭证表 / 指标表**。列级 schema 未拍板，下面是设计草图。

```ts
/** 打开/迁移。路径由 service 传入，data 不自己猜 cwd 以外的魔法位置 */
function openDb(sqlitePath: string): Db

function upsertTraceMeta(db: Db, raw: RawTrace): void

function replaceSegments(db: Db, trace_id: TraceId, cards: SegmentCard[]): void

function insertLabelDecisions(db: Db, decisions: LabelDecision[]): void

function insertWarrant(db: Db, warrant: CutWarrant): void

function insertCutPlan(db: Db, plan: CutPlan): void

function insertUsage(db: Db, row: {
  trace_id: TraceId
  role: AgentRole
  input_tokens: number
  output_tokens: number
}): void

function insertMetrics(db: Db, row: MetricsRow): void

function loadSegmentQueue(db: Db, trace_id: TraceId): {
  resolved: LabelDecision[]
  unresolved_ids: string[]
}

function ruleCoverage(db: Db, trace_id: TraceId): {
  total: number
  ruled: number
  llm: number
  fail_closed: number
}
```

表草图：

```text
traces(trace_id PK, source, ground_truth_ref, total_tokens, raw_path, created_at)
segments(trace_id, segment_id, tool, sig, outcome, rep_of, tokens, focus, head, raw_refs_json)
labels(trace_id, segment_id, label, source_kind, source_name, confidence, rule_name)
warrants(trace_id, segment_id, action, source_kind, source_name, confidence, dead_end_summary)
plans(trace_id, profile_id, kept_json, collapsed_json, dropped_json, span_ok)
usage(id, trace_id, role, input_tokens, output_tokens)
metrics(trace_id, compression_ratio, distill_cost_ratio, key_step_recall, replay, qa, coherence, composite)
```

JSONL 读写不属于 data（那是 [utils.md](./utils.md)）。data 只接受已解析对象。

---

## 3. 职责与边界

**做**

- schema migration（简单 version 表即可）。
- 事务：一轮 distill 的段+标签+凭证应能原子提交，失败不留半截。
- 查询函数给 eval / report / orchestrator。

**禁止**

- 在 data 层判断 Label。
- 把 pi 调用藏进 repository。
- 让 pipeline 文件 `import sqlite`。
- 用 SQLite 存整份 RawTrace 正文当默认（原文已经在 JSON 文件里）。段表只存卡片字段 + refs。若要离线审计，存 `raw_path`。

---

## 4. 依赖关系

```text
data → types, enums, domain（序列化）
    ← orchestrator, eval, service（打开路径）
    ✗ agent/sessions
    ✗ report 的 HTML 字符串拼接（report 可以读 data 函数拿 JSON，再自己渲染）
```

biz 不碰 SQLite：**lint 门禁建议** `src/pipeline/**`、`src/agent/**` 禁止出现 `sqlite` 字符串。

---

## 5. 关键规则 / 算法

- 分层纪律：所有库操作走 data（architecture v0.3）。
- 指标与「LLM 只看 X%」必须能从 labels.source_kind 聚合，禁止报告层口头估。
- 处理成本比分子 = `usage` 中 `hole_a_skeleton` + `hole_b_label`；不含 `l4_*`（ADR-0007）。
- Admission Gate 在 adapter；data 仍应拒绝插入 `ground_truth_ref` 为空的 traces，当第二道闸。

---

## 6. 仍开放的设计问题

1. **正式 schema 未拍板**（TODO P0）。本文件是草图，动工前还要按第一条真实 RawTrace 的字段收一轮。
2. **是否存 LLM 原始输出**：利于 debug，利于复现纠纷；占空间、可能含 prompt 注入内容。建议默认不存，`--keep-completions` 才存。
3. **多轮 review 回填如何在 warrants 里表示**：覆盖写，还是 append 带 round？评测要对着最终 plan，但「回填了两次」是成本叙事。建议 warrants 最终态 + 单独 `review_rounds` 表或 metrics 字段。
4. **SQLite 文件放哪**：`data/distilled/<trace_id>.sqlite` 还是一个总库？批量（M3）时总库更好；MVP 单文件总库 `data/distiller.sqlite` 即可。未写进 architecture。

---

## 7. 实现完成标准

- [ ] migration 可空库启动。
- [ ] 规则覆盖率查询与插入的 LabelDecision 对得上，有单测（可用内存 sqlite）。
- [ ] pipeline/agent 源码无直接 sqlite。
- [ ] 无 GT 的 insertTrace 失败。
- [ ] usage 按 role 聚合函数给 eval 用。
