# 准入与预处理

流水线前端是纯代码：原料进门、对齐成规范 Trace、切成段、能定的标签先定完。**只有规则判不了的段才进洞。** 洞 A/B 怎么打标不在本文件（见 [tools.md](./tools.md)、[agent-sessions.md](../modules/agent-sessions.md)）。

模块契约：[adapters.md](../modules/adapters.md)、[pipeline-segmenter.md](../modules/pipeline-segmenter.md)、[pipeline-rules.md](../modules/pipeline-rules.md)。编排顺序：[pipeline-orchestrator.md](../modules/pipeline-orchestrator.md)。

---

## 目的

- 把「一条 JSONL 怎么变成可打标的段列」写成一条人能跟着走的链。
- 把 **session ≠ trace** 写成硬边界：切分策略未拍板之前，前端拒绝多任务，而不是猜着切。
- 钉死 MVP 原料：claude-code JSONL 优先。

---

## 读者

- 准备 3–5 条成功 Trace 的人（M1 原料）。
- 写 adapter / segmenter / rules 的人。
- 想把 pi session、SWE-bench、openclaw 接进来的人——请先看 MVP 优先级和开放问题，不要插队改准入规则。

训练侧 / 复盘侧怎么跑命令，见 [users-and-surfaces.md](./users-and-surfaces.md)。

---

## 已定结论

1. **Admission Gate 在解析时就执行**（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）。无 Ground Truth（测试通过 / 任务产出被确认）一律不进流水线、不进 SQLite。成功必须是原料自带的可验证标记，禁止 LLM 判断「这算不算成功」，禁止「看起来像成功」就放行。
2. **失败 Trace 不分析**。拒绝即可，不写失败原因报告。以后若要做失败分析，必须另开产品边界。
3. **一条 Trace = 一个任务**。意图推断和切段都假设任务单一。Claude Code 一条 session 常含多个任务（修 bug 顺带重构），**session ≠ trace**。
4. **前端无 LLM**。adapters / segmenter / rules 都是纯 TypeScript。编排器内部也不调 LLM（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。
5. **规则优先**（[ADR-0002](../adr/0002-rule-first-labeling.md)）。失败调用、重复读、相似重试等，能定的尽量在进洞之前定完。粗账：规则清完大约剩 30% 段给洞 B（ADR-0009）。不确定就留未决——宁少标，勿错杀关键决策。
6. **MVP 原料：claude-code JSONL 优先**。pi session、SWE-bench 随后。openclaw 若与 Claude Code 同构，可复用同一 parser。
7. **卡片零 LLM**（ADR-0009）。`head` 是原文截首句，不是摘要。`sig` / `rep_of` / `focus` 由代码填。

---

## 怎么用 / 怎么跑

前端是这一条链，中间没有洞：

```text
原料文件
  → Admission Gate + adapters     认格式、抽 Ground Truth、对齐成 RawTrace
  → segmenter                     Action Unit → Segment / 卡片（无标签、无意图）
  → rules                         能定的打上；聚类；依赖图；噪音降为 line
  → unresolved_ids 才进洞 B       洞 A 仍要做一次头尾意图（不是打标）
```

「未决才进洞」指 **洞 B 逐窗打标**。洞 A 读的是头 1–2 turn + 验证点附近，约 2k token，不读全量，也不负责把规则已决议段再标一遍。

### 1. Admission Gate → adapters

输入：磁盘上的 session JSON / JSONL（以及后续的 SWE-bench 包）。输出：一份带 `ground_truth` 的 RawTrace。adapter 不写库、不打标、不生成卡片。

做的事：

- 认出格式（`--source claude-code` 或 sniff）。认不出抛错，不要返回空 Trace。
- 抽出 Ground Truth 证据位置（测试日志、resolved 标记等），标出验证点附近的 turn id，供洞 A 当硬锚点。验证点**不是死板末尾**——干完正事常还有写文档 / 清理 / 闲聊。
- `trace_id` 稳定：原料自带 id，否则确定性哈希。同一文件跑两次 id 必须相同。禁止随机 UUID。

拒绝要能区分（CLI 才能给人话）：

| 错误码 | 何时 |
|--------|------|
| `no_ground_truth` | 没有可验证完成标记 |
| `unparseable` | 不是能认的格式 / 坏文件 |
| `multi_task_ambiguous` | 看起来一条 session 里不止一个任务，且切分策略尚未拍板 |

无 GT 的夹具必须被拒绝；成功路径不得把失败分析对象「顺便」收进来。

### 2. segmenter

按 **Action Unit** 切：一次思考 + 一次工具调用 + 返回 = 一段。这是产品定义，不是按 token 窗口切，CutProfile 也不得反推「少切一点」。

- 假设输入**已经是单任务** RawTrace。多任务不在这一层补刀。
- 产出 AgentView 的段列：id、工具名、读写路径、token、head、指回原文的 raw_refs。意图和四类标签此处为空。
- 切多少段必须可复现，否则 benchmark 数字会漂。
- 原文不丢：卡片只是投影，Training Cut 还要靠 raw_refs 回原文。

### 3. rules

规则吃卡片（必要时才看 outcome 原文），写出已决议的 LabelDecision，以及 `unresolved_ids`。

MVP 至少这些（规则名要稳定，报告「点开删除理由」靠它）：

| 规则 | 典型结果 | 进不进洞 B |
|------|----------|------------|
| 失败调用且后续无新信息 | 死胡同 | 否 |
| 重复读同一文件、中间无 write | 例行操作 | 否 |
| 相似报错重试（token Jaccard 聚类） | 成员多为死胡同 / 例行；代表段或未决或死胡同 | 成员否；代表段看规则 |
| 读过的文件后来被改过 | **hint**，默认仍未决（有效探索强信号，不是自动关键决策） | 是 |

已决议噪音段 `focus = line`。未决保持 `card`。几乎不应默认 `full`——原文靠洞 B 自己 `read_segment`。

规则**不看**压缩率目标。因为还不够短就多删，会错杀关键决策。覆盖率数字（「LLM 只看了 X%」）进报告首页，从已决议段数 / 总段数算，不在这一层凑。

### 4. 交给洞之前

编排器把 `unresolved_ids` 按窗口切开，注入骨架，逐窗打标。规则已决议段洞 B 根本看不到。`--no-llm` 时未决全 keep，前端仍然要完整跑完：这是「无洞保守导出」、打通压缩率统计的路。

文件依赖图的边在 rules 里连；segmenter 只负责节点上的 reads/writes 数组。图是给洞 B 的免费置信度，不替代打标。

### MVP 原料怎么准备

1. 本地跑 Claude Code，留下 JSONL session。
2. **只收最终做对了的**：测试套件通过，或有等价的可核对证据。SWE-bench 的 resolved 标记同样合格，但 parser 不是 MVP 第一刀。
3. **人工确认这是一个任务**。修 bug 顺带重构、用户中途换题，在切分策略拍板前不要丢进 adapter——应拆成两条或标 `multi_task_ambiguous`。
4. 放到 `data/raw/`（真实数据默认 gitignore）。
5. M1 目标 3–5 条，先求质量与 Ground Truth 硬，不求数量。

openclaw session 若字段与 Claude Code 同构，复用 parser，不要为了品牌再写一套准入例外。

---

## 边界（非目标）

前端明确不做：

- **不把一条多任务 session 猜成一条 Trace**。切分算法未定之前，只接受已经是单任务的原料；疑似多任务返回 `multi_task_ambiguous`。**adapter 没法在这题拍板前写完「自动切分」。**
- **不在 adapter 里切 Action Unit、打标签、画依赖图、生成 `sig` / `head`。**
- **不在 segmenter 里跑准入、打四类标签、伪造意图文案。**
- **不在 rules 里调洞、执行裁剪、为了覆盖率把未决标成例行。**
- **不分析失败 Trace，不调 LLM 当质检员。**
- **不让 CutProfile / 压缩率目标改变切段粒度。**
- **MVP 不把 SWE-bench / pi session 当成第一原料。** 目录和类型可以预留 `TraceSource`，实现顺序仍是 claude-code JSONL。

session ≠ trace 写进边界的方式：**拒绝，而不是启发式切开。** 意图推断、验证点锚点、因果骨架都假设一个任务；切错会污染整条骨架，且评测对不上。开放问题关闭（ADR 或 TODO 勾掉）之前，任何「先按 user 消息切一刀再说」的实现都算出界。

---

## 开放问题

这些是前端写死之前必须关掉的；其中多任务切分是 P0 阻塞项。

1. **多任务 session 切分（P0）**：按 user 新指令？按 git commit？按测试套件切换？切错污染骨架。在 ADR / TODO 关闭前，adapter 只接受单任务，否则 `multi_task_ambiguous`。
2. **Ground Truth 在 Claude Code JSONL 里的具体形状**：测试命令输出？用户说「好了」？现有文档只有原则。没有形状，Admission Gate 的夹具写不真。
3. **验证点定位算法（P0）**：谁切出头 1–2 turn + 验证点附近——建议 adapter 产出 `anchor_turn_ids`，sessions 只读这些 id，不得擅自改读全量。
4. **`sig` 生成规则（P0）**：同质动作的键。不定这个，rules 的相似重试聚类没法写。建议切段层生成 sig，rules 聚类后回填 `rep_of`。
5. **token 口径（P0）**：工具输出全文算不算进段 token / 压缩率分子分母。口径不定，10%–30% 没法验收。
6. **纯思考轮、一次思考里连续两次工具**：一段还是两段，PRD 的 Action Unit 定义有缺口（见 segmenter 开放问题）。
7. **SWE-bench 包结构**本仓库还没有样例；parser 细节不能从现有文档发明。

---

## 完成标准

- [ ] 无 GT 的 claude-code 夹具被拒绝，错误码 `no_ground_truth`，不入库、不切段。
- [ ] 有 GT 的单任务 claude-code JSONL 能得到 RawTrace，工具调用顺序可还原；同一输入两次 parse 得到同一 `trace_id`。
- [ ] 疑似多任务输入得到 `multi_task_ambiguous`，而不是一条混杂 Trace。
- [ ] adapters / segmenter / rules 源码无 pi、无 sqlite；切段稳定（段数、id、raw_refs）。
- [ ] 规则已决议 id 与 `unresolved_ids` 不相交；每条规则决策有稳定 `rule_name`。
- [ ] `--no-llm` 能从前端跑到保守 CutPlan（未决全 keep）。
- [ ] 文档与实现都不把 session 默认为 trace；自动切分未关闭前不宣称 adapter 完成。
- [ ] MVP 路径的 README / `--help` 写明：先喂 claude-code JSONL。
