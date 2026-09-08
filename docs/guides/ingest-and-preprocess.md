# 准入与预处理

流水线前端是纯代码：原料进门、对齐成规范 Trace、切成段、能定的标签先定完。**只有规则判不了的段才进洞。** 洞 A/B 怎么打标不在本文件（见 [tools.md](./tools.md)、[agent-sessions.md](../modules/agent-sessions.md)）。

模块契约：[adapters.md](../modules/adapters.md)、[pipeline-segmenter.md](../modules/pipeline-segmenter.md)、[pipeline-rules.md](../modules/pipeline-rules.md)。编排顺序：[pipeline-orchestrator.md](../modules/pipeline-orchestrator.md)。

---

## 目的

- 把「一条 JSONL 怎么变成可打标的段列」写成一条人能跟着走的链。
- 把 **session ≠ trace** 写成硬边界，并钉死 MVP 切分默认。
- 钉死 MVP 原料：claude-code JSONL 优先；SWE-bench 类型预留、MVP 不做。

---

## 读者

- 准备 3–5 条成功 Trace 的人（M1 原料）。
- 写 adapter / segmenter / rules 的人。
- 想把 pi session、SWE-bench、openclaw 接进来的人——请先看 MVP 优先级，不要插队改准入规则。

训练侧 / 复盘侧怎么跑命令，见 [users-and-surfaces.md](./users-and-surfaces.md)。

---

## 已定结论

1. **Admission Gate 在解析时就执行**（[ADR-0001](../adr/0001-ground-truth-admission-gate.md)）。无 Ground Truth（测试通过 / 任务产出被确认）一律不进流水线、不进 SQLite。成功必须是原料自带的可验证标记，禁止 LLM 判断「这算不算成功」，禁止「看起来像成功」就放行。
2. **失败 Trace 不分析**。拒绝即可，不写失败原因报告。以后若要做失败分析，必须另开产品边界。
3. **一条 Trace = 一个任务**。意图推断和切段都假设任务单一。Claude Code 一条 session 常含多个任务（修 bug 顺带重构），**session ≠ trace**。
4. **前端无 LLM**。adapters / segmenter / rules 都是纯 TypeScript。编排器内部也不调 LLM（[ADR-0008](../adr/0008-pipeline-plus-two-agent-holes.md)）。
5. **规则优先**（[ADR-0002](../adr/0002-rule-first-labeling.md)）。失败调用、重复读、相似重试等，能定的尽量在进洞之前定完。粗账：规则清完大约剩 30% 段给洞 B（ADR-0009）。不确定就留未决——宁少标，勿错杀关键决策。
6. **MVP 原料：claude-code JSONL 优先**。pi session 随后。**SWE-bench：MVP 不做，类型预留**（`TraceSource` 可先占位）。openclaw 若与 Claude Code 同构，可复用同一 parser。
7. **卡片零 LLM**（ADR-0009）。`head` 是原文截首句，不是摘要。`sig` / `rep_of` / `focus` 由代码填。

### 已定默认（原开放问题，用户已全收）

8. **多任务切分（session ≠ trace）**  
   按下一条「像新任务」的 **user 指令轮**切。MVP 若置信度不够，仍返回 `multi_task_ambiguous`，**不按 git commit 切**。

9. **Ground Truth 形状**  
   优先显式 GT 元数据；否则取**最后一次成功测试类工具结果**（exit 0 / PASS）；否则拒绝。**不接受**纯用户口头「好了」当唯一 GT。

10. **洞 A 锚点**  
    任务内前 1–2 轮（含首条 user）+ GT 证据 turn ± 邻近 1–2 个 Action Unit。**不是** session 物理末尾。adapter 产出 `anchor_turn_ids`；sessions 只读这些 id，不得擅自改读全量。

11. **`sig` 生成规则**  
    `sig` = tool 名 + 规范化目标：
    - Read / Edit / Write → 路径
    - Bash → 去数字和临时路径后的命令模板
    - 其它 → 主参数指纹  
    切段层生成；rules 聚类后回填 `rep_of`。

12. **token 口径（压缩率）**  
    分子、分母都按 **RawTrace 原文 token**：工具输出全文进分母；keep 段原文 token 之和为分子。Playback 卡片另算展示长度，**不另搞一套压缩率**。

13. **切段（Action Unit）**  
    1 次工具调用 + 结果 = 一段，紧前 thinking 归这段；连续两次工具 = 两段；无工具纯思考 = 独立段。

14. **SWE-bench**  
    MVP 不做；类型预留即可，parser 不插队。

---

## 怎么用 / 怎么跑

前端是这一条链，中间没有洞：

```text
原料文件
  → Admission Gate + adapters     认格式、抽 Ground Truth、对齐成 RawTrace、产出 anchor_turn_ids
  → segmenter                     Action Unit → Segment / 卡片（含 sig；无标签、无意图）
  → rules                         能定的打上；聚类回填 rep_of；依赖图；噪音降为 line
  → unresolved_ids 才进洞 B       洞 A 仍要做一次头尾意图（读 anchor_turn_ids，不是打标）
```

「未决才进洞」指 **洞 B 逐窗打标**。洞 A 读的是锚点 turns（任务前 1–2 轮 + GT 证据邻近）+ 卡片索引，约 2k token，不读全量，也不负责把规则已决议段再标一遍。

### 1. Admission Gate → adapters

输入：磁盘上的 session JSON / JSONL（SWE-bench 包类型预留，MVP 不解析）。输出：一份带 `ground_truth` 与 `anchor_turn_ids` 的 RawTrace。adapter 不写库、不打标、不生成卡片。

做的事：

- 认出格式（`--source claude-code` 或 sniff）。认不出抛错，不要返回空 Trace。
- **抽 GT**：优先显式 GT 元数据；否则最后一次成功测试类工具结果（exit 0 / PASS）；否则 `no_ground_truth`。口头「好了」单独出现不算。
- **锚点**：标出任务内前 1–2 轮（含首条 user）与 GT 证据 turn ± 邻近 1–2 个 Action Unit，写入 `anchor_turn_ids`。验证点**不是死板末尾**——干完正事常还有写文档 / 清理 / 闲聊。
- **多任务**：检测下一条「像新任务」的 user 指令轮；能自信切开则切成多条 Trace，否则 `multi_task_ambiguous`。**不按 git commit 切。**
- `trace_id` 稳定：原料自带 id，否则确定性哈希。同一文件跑两次 id 必须相同。禁止随机 UUID。

拒绝要能区分（CLI 才能给人话）：

| 错误码 | 何时 |
|--------|------|
| `no_ground_truth` | 没有可验证完成标记（无显式 GT，也无成功测试类工具结果） |
| `unparseable` | 不是能认的格式 / 坏文件 |
| `multi_task_ambiguous` | 看起来一条 session 里不止一个任务，且「像新任务」切分置信度不够 |

无 GT 的夹具必须被拒绝；成功路径不得把失败分析对象「顺便」收进来。

### 2. segmenter

按 **Action Unit** 切（已定默认）：

- **1 次工具调用 + 结果 = 一段**；紧前 thinking 归这段。
- **连续两次工具 = 两段**。
- **无工具纯思考 = 独立段**。

这是产品定义，不是按 token 窗口切，CutProfile 也不得反推「少切一点」。

- 假设输入**已经是单任务** RawTrace（或 adapter 已按「像新任务」切开）。多任务不在这一层补刀猜。
- 产出 AgentView 的段列：id、工具名、读写路径、token、head、`sig`、指回原文的 raw_refs。意图和四类标签此处为空。
- **`sig`**：tool 名 + 规范化目标（见上表）；本层生成，供 rules 聚类。
- 切多少段必须可复现，否则 benchmark 数字会漂。
- 原文不丢：卡片只是投影，Training Cut 还要靠 raw_refs 回原文。
- **token**：段上统计用 RawTrace 原文 token（工具输出全文计入）；压缩率口径见已定结论 §12。

### 3. rules

规则吃卡片（必要时才看 outcome 原文），写出已决议的 LabelDecision，以及 `unresolved_ids`。聚类后回填 `rep_of`（代表段指向）。

MVP 至少这些（规则名要稳定，报告「点开删除理由」靠它）：

| 规则 | 典型结果 | 进不进洞 B |
|------|----------|------------|
| 失败调用且后续无新信息 | 死胡同 | 否 |
| 重复读同一文件、中间无 write | 例行操作 | 否 |
| 相似报错重试（按 `sig` / token Jaccard 聚类） | 成员多为死胡同 / 例行；代表段或未决或死胡同 | 成员否；代表段看规则 |
| 读过的文件后来被改过 | **hint**，默认仍未决（有效探索强信号，不是自动关键决策） | 是 |

已决议噪音段 `focus = line`。未决保持 `card`。几乎不应默认 `full`——原文靠洞 B 自己 `read_segment`。

规则**不看**压缩率目标。因为还不够短就多删，会错杀关键决策。覆盖率数字（「LLM 只看了 X%」）进报告首页，从已决议段数 / 总段数算，不在这一层凑。

### 4. 交给洞之前

编排器把 `unresolved_ids` 按窗口切开，注入骨架，逐窗打标。规则已决议段洞 B 根本看不到。洞 A 只读 adapter 给出的 `anchor_turn_ids`。`--no-llm` 时未决全 keep，前端仍然要完整跑完：这是「无洞保守导出」、打通压缩率统计的路。

文件依赖图的边在 rules 里连；segmenter 只负责节点上的 reads/writes 数组。图是给洞 B 的免费置信度，不替代打标。

### MVP 原料怎么准备

1. 本地跑 Claude Code，留下 JSONL session。
2. **只收最终做对了的**：优先带显式 GT 元数据；否则能指出最后一次成功测试类工具结果（exit 0 / PASS）。SWE-bench resolved 标记原则合格，但 **MVP 不做 SWE-bench parser**。
3. **人工确认这是一个任务**，或接受 adapter 按「像新任务」user 轮切开。修 bug 顺带重构、用户中途换题，置信度不够时标 `multi_task_ambiguous`，不要硬塞成一条。
4. 放到 `data/raw/`（真实数据默认 gitignore）。
5. M1 目标 3–5 条，先求质量与 Ground Truth 硬，不求数量。

openclaw session 若字段与 Claude Code 同构，复用 parser，不要为了品牌再写一套准入例外。

---

## 边界（非目标）

前端明确不做：

- **不按 git commit 切多任务**。默认是「像新任务」的 user 指令轮；置信度不够就 `multi_task_ambiguous`，而不是启发式乱切。
- **不接受口头「好了」当唯一 GT**。
- **不把洞 A 锚点定在 session 物理末尾**；必须用 `anchor_turn_ids`。
- **不在 adapter 里打四类标签、画依赖图**；`sig` / `head` 在切段层，`rep_of` 在规则层回填。
- **不在 segmenter 里跑准入、打四类标签、伪造意图文案。**
- **不在 rules 里调洞、执行裁剪、为了覆盖率把未决标成例行。**
- **不分析失败 Trace，不调 LLM 当质检员。**
- **不让 CutProfile / 压缩率目标改变切段粒度。**
- **不为 Playback 卡片另搞一套压缩率**；展示长度可另计，验收压缩率只认 RawTrace 原文 token。
- **MVP 不做 SWE-bench / 不把 pi session 当成第一原料。** 目录和类型可以预留 `TraceSource`，实现顺序仍是 claude-code JSONL。

session ≠ trace：**能自信按新任务 user 轮切开则切；否则拒绝，而不是按 commit 猜。** 意图推断、验证点锚点、因果骨架都假设一个任务；切错会污染整条骨架，且评测对不上。

---

## 开放问题

前端默认已收口；仍未锁死的是实现细节，不是方向：

1. **「像新任务」的置信度启发式**（措辞 / 话题漂移阈值）：阈值与阈值未写进 ADR；不够自信时必须退回 `multi_task_ambiguous`。
2. **测试类工具白名单**（哪些 Bash / 测试命令算「成功测试类」）：形状原则已定，枚举表落 adapters 夹具时再钉。
3. **token 计数器实现**（用哪套 tokenizer / 是否与 provider 对齐）：口径已定（RawTrace 原文），计数库选型未锁。
4. **`trace_id` 哈希输入集合**：同一文件两次 parse 必须同一 id（原则已定）。
5. **SWE-bench 包结构**本仓库还没有样例；MVP 不做，类型预留即可。

---

## 完成标准

- [ ] 无 GT 的 claude-code 夹具被拒绝，错误码 `no_ground_truth`，不入库、不切段；口头「好了」单独出现不能放行。
- [ ] 有 GT 的单任务 claude-code JSONL 能得到 RawTrace（含 `anchor_turn_ids`），工具调用顺序可还原；同一输入两次 parse 得到同一 `trace_id`。
- [ ] 疑似多任务且切分置信度不够 → `multi_task_ambiguous`；不按 git commit 切开。
- [ ] 切段遵守：一工具一段（紧前 thinking 归段）、连续两工具两段、纯思考独立段；`sig` 由切段层生成，`rep_of` 由 rules 回填。
- [ ] 压缩率分子分母均按 RawTrace 原文 token；Playback 展示长度不另冒充压缩率。
- [ ] adapters / segmenter / rules 源码无 pi、无 sqlite；切段稳定（段数、id、raw_refs）。
- [ ] 规则已决议 id 与 `unresolved_ids` 不相交；每条规则决策有稳定 `rule_name`。
- [ ] `--no-llm` 能从前端跑到保守 CutPlan（未决全 keep）。
- [ ] 文档与实现都不把 session 默认为 trace；MVP 路径不宣称已做 SWE-bench parser。
- [ ] MVP 路径的 README / `--help` 写明：先喂 claude-code JSONL。
