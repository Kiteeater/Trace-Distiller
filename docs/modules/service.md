# service — 入口薄壳

对应路径：`src/service/`。architecture：`cli.ts`（命令）、`report.ts`（调 renderer）。换展示形态只动这层；换编排不走这层。

---

## 1. 目的 / 非目标

**目的**

- 解析 argv、读 CutProfile、打开 SQLite 路径、调 `orchestrator.distill`、把 `ReportModel` 交给 `report.renderHtml`、写输出文件、设进程退出码。
- 把「人怎么调用」和「流水线怎么走」隔开。

**非目标**

- 不实现切段/打标/洞。
- 不做交互式 TUI、不做 web API。
- 不在 CLI 里写步骤顺序的第二种编排（禁止 `if (flag) skipRules` 变成第二套产品逻辑——flag 应映射成 CutProfile / DistillInput 上的显式字段，由 orchestrator 解释）。
- 不处理飞书/IM。本工具是离线 CLI。

---

## 2. 输入输出

```ts
/** src/service/cli.ts */
interface CliArgs {
  command: 'distill' | 'eval' | 'report'
  input_path: string
  profile_path?: string
  sqlite_path?: string
  out_dir?: string
  report_path?: string
  no_llm?: boolean
}

function parseArgv(argv: string[]): CliArgs
function runCli(args: CliArgs): Promise<number>  // exit code

/** src/service/report.ts */
function writeReport(model: ReportModel, outPath: string): void
```

进程入口是 [script-run-distill.md](./script-run-distill.md)，它只 import service。

输出：

- `data/distilled/` 下 Training / Playback（命名见仓库 `data/distilled/README.md`：`*-training.*` / `*-playback.*`）
- 可选 `.html`
- SQLite 更新

---

## 3. 职责与边界

**做**

- 参数校验、帮助文本。
- 选 adapter（`--source claude-code` 或 sniff）。
- 加载默认 CutProfile（constant）或用户 JSON/TS 配置。
- 捕获 AdmissionError，用人话打印「无 Ground Truth，拒绝入库」。
- 组装 ReportModel（从 DistillResult + data 查询）。

**禁止**

- import pi。
- 手写 SQL。
- 在 cli.ts 里复制一份规则。
- 启动 HTTP listen。

---

## 4. 依赖关系

```text
service
  → adapters, pipeline/orchestrator, eval, report, data, types, constant, utils
  ✗ agent/sessions（让 orchestrator/eval 去调）
  ✗ pi
```

允许 service 调 adapters（读文件 → RawTrace）再交给 orchestrator，这样 orchestrator 可以假设输入已是 RawTrace。

---

## 5. 关键规则 / 算法

- 薄壳：architecture 与 macaron 的 service 对应，裁掉在线中间件。
- 退出码建议：0 成功；2 准入拒绝；3 span 失败；4 review 门禁失败（M2 才当门禁）；1 其它。未拍板，实现时写进 `--help`。
- `--no-llm` 对应落地顺序第 3 步：无洞保守导出。必须有，否则契约层无法在没 key 时集成。

---

## 6. 仍开放的设计问题

1. CutProfile 文件格式：JSON 还是 TS 模块。0009 说「声明式 TS 类型 + 默认值」，CLI 吃 profile——运行时 JSON 更省事。
2. 子命令要不要单独的 `eval`：M1 可以 `distill` 顺带盲测。
3. 退出码与 M2 门禁绑定方式。

---

## 7. 实现完成标准

- [ ] `--help` 可用。
- [ ] 无 GT 输入退出码非 0，且不写 distilled 产物。
- [ ] `--no-llm` 在 mock 环境跑通。
- [ ] `report.ts` 只负责写文件，HTML 内容来自 `report/renderHtml`。
- [ ] 无 HTTP server、无 pi import。
