# Trace Distiller Context

本文件只定义 Trace Distiller 的产品语言：同一概念只用一个词。不含实现细节。

## Language

### 原料与准入

**Trace**：
一次 agent 任务执行留下的完整结构化记录，含思考、工具调用与返回结果。
_Avoid_: log, session dump, transcript（泛指时）

**Ground Truth**：
可独立验证的完成标记，证明该 Trace「最终做对了」（如测试通过、任务产出被确认）。无 Ground Truth 的 Trace 一律不进入流水线。
_Avoid_: 看起来成功, 人工主观觉得对, 失败分析对象

**Admission Gate**：
只放行带 Ground Truth 的 Trace 的输入门槛。
_Avoid_: soft filter, 质量评分准入

### 流水线单元

**Action Unit（动作单元）**：
切段的最小单位：一次思考 + 一次工具调用 + 返回。
_Avoid_: step（歧义）, message, turn（聊天轮次）

**Segment（段）**：
一条 Action Unit 切出后的可打标片段。
_Avoid_: chunk, window（窗口是打标时的批处理概念）

**Label（标签）**：
对 Segment 的四选一分类：关键决策 / 有效探索 / 死胡同 / 例行操作。
_Avoid_: score, ranking, importance（连续分）

**关键决策（Key Decision）**：
改变后续方向的 Segment（换了思路、定位到根因、选定方案或确认结论）。
_Avoid_: important step, milestone

**有效探索（Useful Exploration）**：
虽未直接成功，但排除了错误方向、为关键决策提供证据的 Segment。
_Avoid_: trial, experiment（未区分是否有效）

**死胡同（Dead End）**：
失败且对后续无信息量的尝试。剪辑时不整段保留细节，只保留少量代表性死胡同的一句排除说明。
_Avoid_: failure, error（失败调用可能只是例行重试）

**代表性死胡同（Representative Dead End）**：
剪辑重组时留下的少量死胡同摘要，形如「此处尝试 X 失败，已排除」，用于保持因果路径完整，而非复述失败过程。
_Avoid_: 全量失败日志, 逐条重试记录

**例行操作（Routine）**：
纯流程、无信息增量的 Segment（读配置、确认环境、重复读同一文件、机械重试等）；剪辑时删除。
_Avoid_: noise, boilerplate

**因果路径（Causal Path）**：
从「接到任务」到「做对」之间，对结论成立仍必要的决策与证据链条；压缩版 Trace 必须保留这条路径。
_Avoid_: 全文摘要, 亮点摘录（可丢因果）

### 打标与剪辑

**Rule Layer（规则层）**：
用确定性规则自动打标的层（失败调用、重复读文件、相似报错重试等）。
_Avoid_: heuristic-only, regex filter（过窄）

**LLM Layer（LLM 层）**：
仅处理规则层判不了的「探索价值」模糊段。
_Avoid_: LLM-first, full-trace LLM pass

**Edit Reassembly（剪辑重组）**：
按标签保留 / 压缩 / 删除 Segment，并施加步长跨度约束后生成精华 Trace。
_Avoid_: summarization（泛摘要）, pruning（只删不重组）

**Span Constraint / 够得着（步长跨度约束）**：
相邻保留步之间的能力跨度上限：剪后版本必须「够得着」，步与步不能跳太远，否则训练等于喂幻觉。
_Avoid_: max gap, continuity check（未强调能力边界）

### 产物与评估

**Training Cut（训练版）**：
面向 SFT 的精华 Trace 产物。
_Avoid_: dataset row, cleaned trace

**Playback Cut（回放版）**：
面向人类阅读的「导演剪辑版」精华 Trace。
_Avoid_: summary report, dashboard view

**Compression Ratio（压缩率）**：
剪后 token / 原 token；MVP 目标先做到 10%–30%。
_Avoid_: length reduction, step count only

**Fidelity（保真度）**：
硬指标：只看剪后 Trace 能否复述完整解题路径并到达同一结论，或按剪后路径重放任务仍「走得通」。
_Avoid_: accuracy, correctness（未强调路径可复述）

**Blind Replay（保真度盲测）**：
新开对话，只喂剪后 Trace，问「这个 agent 是怎么解决的、关键转折在哪」；或按剪后路径重放任务。答得上来 / 走得通即过关。
_Avoid_: side-by-side review, open-book check

### Benchmark

**关键步召回率（Key-Step Recall）**：
原始 Trace 中被金标为关键决策的步骤，在剪后版本中仍存活的比例。
_Avoid_: overall recall, step retention（未限定关键步）

**重放成功率（Replay Success）**：
在干净环境中仅按剪后路径重做任务、并达成同一正确结果的比例。
_Avoid_: 口头复述通过, QA 答对（那是 QA 保真度）

**QA 保真度（QA Fidelity）**：
只根据剪后 Trace 回答从原始 Trace 生成的问题，答对比例；作重放的廉价日常替代。
_Avoid_: 重放成功率

**连贯性（Coherence）**：
相邻保留步之间「能否从前一步自然推出后一步」的裁判分；必须卡单步下限，不能只看均值。
_Avoid_: fluency, readability（人类可读性是另一项）

**处理成本比（Distill Cost Ratio）**：
剪辑自身消耗的 token ÷ 剪掉的 token（洞 A+B；不计 L4）。记分板另报 ROI = 省下的 SFT token / 蒸馏花费（ADR-0015）；ROI>1 即单次复用 token 盈利。ROI 不是复合分门禁。
_Avoid_: API bill, absolute token spend

**复合分（Composite Score）**：
六项全部及格后才计算的总分：压缩率得分 × 关键步召回率 × 重放成功率；任一趋零则总分崩盘。
_Avoid_: weighted average, single metric leaderboard

### 运行时

**流水线编排器（Orchestrator）**：
纯 TypeScript 确定性控制流：决定切段、规则、何时开洞、失败重试与导出；内部不调用 LLM。
_Avoid_: LangChain/CrewAI 编排, 用 agent 决定流水线步骤

**Agent 洞（Agent Hole）**：
流水线上唯一允许嵌入 pi LLM 会话的插槽。现行只有两个：洞 A（骨架 pass）、洞 B（逐窗打标；衔接检查复用）。
_Avoid_: Distiller Agent（整条链路一个 agent）, 编排 agent

**骨架 Pass（Skeleton Pass）**：
洞 A 产出的因果骨架（关键转折与主路径假设），注入洞 B 每窗的 context。
_Avoid_: 全文摘要当打标输入, 无骨架的逐段裸打标

**分场景 Skill**：
洞 B 使用的 Markdown 裁剪/打标策略文件；一场景一文件，可版本化、可热更。
_Avoid_: 写死在代码里的超长 system prompt

**保守不裁（Fail-Closed Keep）**：
某窗 LLM 输出解析失败或超 token 时，编排器将该窗降级为保留（宁多勿漏），以保住关键步召回。
_Avoid_: 失败当死胡同删掉, 静默跳过
