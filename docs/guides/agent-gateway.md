# Agent Gateway：离线 Trace 接入门面

> 仓库原先没有「Agent Gateway」这个词。按已定主基调，它就是流水线最前面那扇门：多格式 adapters + Admission Gate + 规范化 RawTrace 出口。

## 目的

给接入侧一个产品名和边界，避免被理解成「在线 agent 流量网关」。写清进什么、出什么、拒绝时什么错误码、门在哪里结束、编排器从哪里开始。

解析字段、sniff 规则、parser 细节以 [docs/modules/adapters.md](../modules/adapters.md) 为准。本页不重复写成类型说明书。

## 读者

- 要把 Claude Code / openclaw / SWE-bench 记录送进 Distiller 的人
- 实现 L0 或 CLI 入口的人（退出码、人话错误）
- 以后听到「Gateway」时需要对齐含义的人

## 已定结论

**Agent Gateway = 离线 Trace 接入门面**，由三块组成：

```text
磁盘上的 session / 产物包
        │
        ▼
  多格式 adapters     认格式、对齐字段、标 GT 证据所在 turn
        │
        ▼
  Admission Gate      无 Ground Truth → 当场拒绝（ADR-0001）
        │
        ▼
  规范化 RawTrace     交给 orchestrator.distill；本门面到此结束
```

它是 architecture 里的 **L0**，纯代码，无 LLM。只解析对齐，不打标、不剪辑、不写库。

对应实现目录：`src/adapters/`。编排器假定拿到的已经是过门的 `RawTrace`（[pipeline-orchestrator.md](../modules/pipeline-orchestrator.md)）。CLI 薄壳可以先调 Gateway 再调编排器（[service.md](../modules/service.md)）。

### 明确不是什么

| 不是 | 为什么 |
|------|--------|
| **在线 agent 流量网关** | 本工具是离线 CLI，不代理运行中的 agent，不插手对方工具调用 |
| **实时干预 / 盯梢** | PRD 与 architecture「明确不做」 |
| **macaron 的 remote / middleware / decorator / observability** | 在线服务那套不抄；离线可观测性 = SQLite 打标表 + 报告成本数字 |
| **失败分析服务** | 失败或无 GT 的输入拒绝即可，不写失败原因报告 |
| **第三个 agent 洞** | 门面无 LLM；不判断「这算不算成功」 |

成功必须是原料**自带**的可验证标记。Gateway 不得用模型猜。

## 输入 / 输出

**输入**（都在磁盘上，不是 HTTP）：

- Claude Code session JSONL（MVP **先做**）
- openclaw session（与 Claude Code 同构则复用 parser）
- pi session
- SWE-bench 成功产物包（随后；仓库尚无样例）

可选 `--source` 提示；不传则 `sniff`。认不出不要返回空 Trace，要报错。

**输出**：一份带 `ground_truth` 的 [RawTrace](../modules/types.md#rawtrace)（`meta` + `ground_truth` + `turns`）。LLM **永远不看**这份原文全量；下游会再做成 AgentView 卡片流。

**副作用**：无。不写 SQLite，不写 `data/distilled`。放行之后由 orchestrator / data 入库；拒绝则 CLI 打印人话并给非 0 退出码。

建议形状（契约在 adapters.md，这里只记产品语义）：

```text
loadRawTrace(path, source?) → RawTrace
  失败 → AdmissionError { code, message }
```

一条 RawTrace = 一个任务。验证点尽量标出 GT 证据所在 turn id，供洞 A 当硬锚点（头尾是启发式，验证点才是硬锚）。找不到就标记缺失，不要假装最后一轮就是验证点——agent 干完正事常还有写文档 / 清理 / 闲聊（[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)）。

## 错误码

接入失败要能区分「不该进」和「解析坏了」，CLI 才能说人话。现行三种（[adapters.md](../modules/adapters.md)）：

| `AdmissionError.code` | 含义 | CLI 建议 |
|-----------------------|------|----------|
| `no_ground_truth` | 没有可验证完成标记 | 「无 Ground Truth，拒绝入库」；不写产物 |
| `unparseable` | 认不出 / 解析失败 | 指出格式或路径；不要装成空成功 |
| `multi_task_ambiguous` | 一条 session 像多个任务，切分策略未定 | 请先拆成单任务再送；切分 ADR 关闭前这是合法拒绝 |

进程退出码（service 建议，实现时写进 `--help`，未完全拍板）：

| 码 | 何时 |
|----|------|
| 0 | 成功 |
| 2 | 准入拒绝（上表三种都走这扇门） |
| 3 | span 失败（**不是** Gateway，是 assembler） |
| 4 | review 门禁失败（M2 才当门禁；**不是** Gateway） |
| 1 | 其它 |

Gateway 只对 **2** 负责。3 / 4 是过门之后的流水线结果，不要在 adapter 里提前发明。

## 与 orchestrator 的边界

```text
script/run-distill.ts
    → service/cli          解析 argv、选 adapter、捕获 AdmissionError
        → Agent Gateway    adapters.loadRawTrace   ← 本页
              只出 RawTrace / AdmissionError
        → orchestrator.distill({ raw, profile })
              切段 / 规则 / 洞 A / 洞 B / 凭证 / assembler / 盲测回填
```

| Gateway 做 | orchestrator 做 |
|------------|-----------------|
| 认格式、对齐 turn、抽出 GT | 假定 `raw` 已过门 |
| 拒绝无 GT / 解析失败 / 多任务歧义 | 切窗、Fail-Closed Keep、skill 路由、回填 |
| 标 `anchor_turn_ids`（建议） | 洞 A 只读这些锚点，不从头扫原文 |
| 稳定 `trace_id`（原料自带或确定性哈希，禁止随机 UUID） | 用该 id 贯穿 SQLite / 评测 |

两种接法都可以，产品边界不变：

1. service 先调 Gateway，再把 `RawTrace` 交给 orchestrator（推荐，编排器更纯）
2. orchestrator 自己调 adapters——但 **GT 检查必须已经发生**，不能「先入库再发现没 GT」

Gateway **禁止**：import pi、写 SQLite、打标签、做相似重试聚类 / 文件依赖图（那是 L1）、生成 AgentView 卡片。

过门之后的故事见 [ingest-and-preprocess.md](./ingest-and-preprocess.md)（切段 + 规则 + 未决才进洞）和 [agent-harness.md](./agent-harness.md)（两个 agent 洞）。

## 怎么用 / 怎么跑

代码未写。预期一天收一条成功 Trace：

```text
# 本地 Claude Code JSONL（M1 优先）
node script/run-distill.ts distill path/to/session.jsonl --source claude-code

# 无 GT → 退出码 2，stderr 人话，data/distilled 不出现新文件
# 过门 → orchestrator 继续；需要报告时加 --report out.html
```

`--no-llm` 是落地顺序里「无洞保守导出」的开关，发生在 **过门之后**，不是 Gateway 的职责。

新格式怎么加：写一个 adapter（`sniff` + `parse`），不要新开 HTTP 服务，也不要在编排器里写 if-else 解析。自定义面的三块是 CutProfile + skill 文件 + **adapter**（[ADR-0009](../adr/0009-agent-view-and-cut-warrant.md)）。

## 边界（非目标）

- 不监听端口、不反向代理、不转发运行中 agent 的工具调用。
- 不抄 macaron remote / middleware。
- 不分析失败 Trace，不产出「为什么失败」报告。
- 不用 LLM 做成功判定或质量打分准入。
- 不在 Gateway 里切 Action Unit（那是 segmenter）。
- 本页不展开各格式字段映射——见 [adapters.md](../modules/adapters.md)。

## 开放问题

与 adapters.md §6 / TODO P0 同一组，关闭前 Gateway 不能宣称「完成」：

1. **多任务 session 切分（P0）**：adapter 在策略拍板前只接受已是单任务的原料。
2. **Claude Code Ground Truth 的具体形状**。
3. **验证点定位**：建议 adapter 产出 `anchor_turn_ids`，sessions 只读 id；谁切这几段尚未钉死。
4. **`trace_id` 稳定性**：同一文件两次 parse 必须同一 id。
5. **SWE-bench 包结构**无样例。
6. 退出码 2 是否细分三种准入失败：产品上三种都是「没进门」；需要机器区分时看 `AdmissionError.code`，不必再拆进程码。

## 完成标准

- [ ] 文档与代码（落地后）都把「Agent Gateway」当作 L0 离线门面，而不是在线网关。
- [ ] 无 GT 夹具 → `no_ground_truth`，退出码非 0，无 distilled 产物。
- [ ] 解析失败与无 GT 错误码可区分。
- [ ] 疑似多任务 → `multi_task_ambiguous`，不静默当一条 Trace。
- [ ] adapter 源码无 pi、无 sqlite；同一输入两次 parse 同一 `trace_id`。
- [ ] orchestrator / eval 文档不把 Gateway 画成第三洞或 HTTP 中间件。
- [ ] 多任务切分策略有 ADR 或 TODO 关闭记录后，才宣称 Gateway 完成。

## 相关文档

- [docs/modules/adapters.md](../modules/adapters.md) — 工程契约（parser、字段、完成标准）
- [ADR-0001](../adr/0001-ground-truth-admission-gate.md)
- [ingest-and-preprocess.md](./ingest-and-preprocess.md) — 过门之后的前端流水线
- [datasets.md](./datasets.md) — 原料从哪来
- [docs/architecture.md](../architecture.md) L0
