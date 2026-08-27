# Trace Distiller 架构

| 字段 | 内容 |
|------|------|
| 版本 | v0.2 |
| 日期 | 2026-08-27 |
| 状态 | 已批准 |
| 语言 | **TypeScript + Node** |

## 核心观念

> 这不是「一个 agent」，是 **流水线 + 两个 agent 洞**。

编排层**不用** agent 框架、**不用** LLM。整条链路只有两处需要 LLM 判断力，这两处才嵌入 pi 内核：

```text
流水线编排器（纯 TS，无 LLM）
│
├─ L0 适配器      → 纯代码（各格式 parser）
├─ L1 切段+规则   → 纯代码（规则引擎）
│
├─ ① 骨架 pass    → 【Agent 洞 A】pi SDK
├─ ② 逐窗打标     → 【Agent 洞 B】pi SDK（骨架注入 context）
│
├─ ③ 全局重组     → 纯代码 + 一次衔接检查（走洞 B 会话）
├─ L3 导出        → 纯代码
└─ L4 评测        → 纯代码统计 + 重放用 pi 起干净会话
```

**为什么编排不用 agent/LLM**：切多少段、先跑哪步、失败怎么重试——都是确定性逻辑。交给 LLM 编排只会引入不可复现性；benchmark 要求数字可复现，编排层必须是纯代码。

一句话映射：

> 流水线用纯代码保证可复现；LLM 判断收敛到两个洞；pi SDK 当洞里的内核；skill 文件承载分场景裁剪策略；SQLite 承载评测闭环——每个组件只干自己擅长的事。

---

## 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 语言/运行时 | TypeScript + Node | pi 为 TS 原生；全家桶一个技术栈，类型贯通 |
| 编排器 | 自写薄 CLI（不用 LangChain / CrewAI） | 流水线确定；框架只会加黑盒；`orchestrator.ts` + 任务队列即可 |
| Agent 内核 | pi SDK（`createAgentSession()`） | 两洞需要程序化嵌入的 LLM 会话；支持 Anthropic / OpenAI / 自定义；Azure 可接 |
| 打标 prompt | pi Skills / Prompt Templates（Markdown） | 每个裁剪场景 = 一个 skill 文件；可单独迭代、可版本化 |
| 模型 | 打标用强模型（Claude Sonnet 级）；骨架 pass 可用更强档 | pi 低脚手架依赖强模型；QA 生成可降档省成本 |
| 存储 | JSONL（I/O）+ SQLite（打标结果、评测指标） | 原料本是 JSONL；指标要可查询对比；SQLite 单文件零运维 |
| 评测重放 | pi 起干净会话跑任务 | 与打标同内核，环境一致 |

---

## 分层与职责

### L0 `adapters/` — 纯代码

- pi session / Claude Code / SWE-bench 等 → 规范 Trace
- 只解析对齐；不做打标、不剪辑
- 无 Ground Truth → 拒绝进入流水线

### L1 切段 + 规则 — 纯代码

- `segmenter.ts`：按 Action Unit 切段  
- `rules.ts`：失败调用、重复读、相似重试等规则打标  
- 规则能定的尽量在进洞之前定完  

### Agent 洞 A — 骨架 pass（pi）

- 对整条（或规约后的）Trace 抽出**因果骨架**：关键转折、主路径假设  
- 产出写入 SQLite / 工作区，供洞 B 每窗注入 system context  
- 模型档位可高于日常打标  

### Agent 洞 B — 逐窗打标（pi）

- 编排器读段队，map-reduce 逐窗开会话  
- 输入：段 + 骨架 context；输出：四类标签 + 置信度  
- 全局重组时的**衔接检查**也走洞 B 会话（一次 LLM，不是再开编排 agent）  

### ③ `assembler.ts` — 全局重组

- 纯代码按标签保留 / 一句压缩死胡同 / 删例行  
- **Span Constraint（够得着）**在此强制；不过则失败或回退策略（仍由纯代码决定）  
- 必要时调洞 B 做相邻步连贯性检查  

### L3 导出 — 纯代码

- Training Cut / Playback Cut；同源 CutPlan  

### L4 `eval/` — 评测

- 压缩率、成本比等：纯统计  
- QA 生成：可降档模型  
- 重放：pi 起**干净会话**跑任务  
- 正式复合分与分档赛道见 [benchmark/README.md](../benchmark/README.md)  

---

## pi 二开：三件事

### 1. 一个 extension

注册自定义工具（prompt 模板放 `skills/`）：

| 工具 | 输入 → 输出 |
|------|-------------|
| `label_segment` | 段 + 骨架 → 四类标签 + 置信度 |
| `check_continuity` | 相邻段 → 衔接是否够得着（及分数/理由） |

### 2. map-reduce 驱动（编排器侧，不必改 pi）

- 读 SQLite 段队 → 逐窗 `createAgentSession()`  
- 骨架 pass 产物注入每窗 system context  
- SDK 原生支持自定义消息序列即可  

### 3. 失败兜底

- 优先要 pi 的结构化 / JSON 模式输出  
- 解析失败或超 token 的窗口：**自动降级为「保守不裁」**（宁多勿漏，对齐召回优先阈值）  

---

## 目录结构

```text
trace-distiller/
├─ src/
│  ├─ adapters/           # L0: pi session / claude-code / swebench
│  ├─ pipeline/
│  │  ├─ segmenter.ts     # 切段
│  │  ├─ rules.ts         # 规则打标
│  │  ├─ orchestrator.ts  # 纯 TS 编排（无 LLM）
│  │  └─ assembler.ts     # 全局重组
│  ├─ agent/              # pi 二开（仅两洞）
│  │  ├─ extension.ts     # label_segment / check_continuity
│  │  ├─ skills/          # 分场景裁剪 skill（Markdown）
│  │  └─ sessions/        # 骨架 / 打标会话封装（内核可换边界）
│  └─ eval/               # L4: 指标 + QA + 重放
├─ data/                  # 原料与产物（JSONL 等）
└─ benchmark/             # 数据集 + 基线报告
```

MVP 先固定 **3–5 个** skill 文件，再扩场景。

---

## 三条活口（有意保留）

| 活口 | 做法 |
|------|------|
| **skill 热更新** | skills 为 Markdown；后期「skill 自优化」只需给洞 B 加 `rewrite_skill`，目录不用动 |
| **模型可换** | 两洞走 pi provider 抽象；打标升/降档后 benchmark A/B 即可 |
| **内核可换** | 编排器与洞之间只经 `agent/sessions/`；pi 撑不住时替换成本限制在该目录 |

---

## 与旧方案的关系

| v0.1（已废弃） | v0.2（现行） |
|----------------|--------------|
| 自主 Agent 运行时编排整条链路 | **纯 TS 流水线编排** |
| ScriptedPolicy / AgentPolicy | **无编排 agent**；仅洞 A / 洞 B |
| 语言未定 | **TypeScript + Node + pi** |
| Brain/Label/Judge 三端口在「一个 runtime」里 | 预算仍分账，但落在**骨架 pass / 打标窗 / 评测重放**三类会话上 |

ADR-0006 已由 [0008](./adr/0008-pipeline-plus-two-agent-holes.md) 取代。

---

## 落地顺序（建议）

1. 规范 Trace 契约 + L0 适配器（先 Claude Code / JSONL）  
2. `segmenter` + `rules` + SQLite 段表  
3. `orchestrator` 串 L0→L1→（跳过洞）→保守导出，打通压缩率统计  
4. 洞 A 骨架 pass（pi session 封装）  
5. 洞 B `label_segment` + map-reduce + skill×3  
6. `assembler` + `check_continuity` + 双产物导出  
7. `eval/`：QA + 成本比；重放接 benchmark  

---

## 明确不做

- 用 LangChain / CrewAI 等编排整条 Distiller  
- 让 LLM 决定切段粒度、流水线步骤顺序或重试策略  
- 把重放成功率塞进每个打标窗口（太贵；属 L4 / 发布门禁）  
- MVP 先做 GUI  
