# script/run-distill — 进程入口

对应路径：`script/run-distill.ts`。architecture 目录树里的 CLI 入口：`distill <trace.jsonl> [--report out.html]`。

薄到不能再薄：解析完把控制权交给 `src/service/cli.ts`。

---

## 1. 目的 / 非目标

**目的**

- 给人类和 CI 一个稳定的命令位置，不随 `src/` 分层改名而变。
- `bun` 装依赖、`node` 跑产物（architecture）：本文件是「跑产物」的那个入口。

**非目标**

- 不写业务。
- 不是第二个 orchestrator。
- 不在这里 `createAgentSession`。
- 仓库当前还没有 `package.json`（TODO P0 工程骨架）。本文件描述的是骨架落地后的入口，现在不要创建 ts 实现。

---

## 2. 输入输出

命令草图：

```text
node script/run-distill.ts distill <trace.jsonl> [--profile p.json] [--report out.html] [--no-llm]
node script/run-distill.ts eval <trace_id>
node script/run-distill.ts report <trace_id> --out out.html
```

stdin/stdout：日志走 stderr；需要机器读的摘要（trace_id、compression_ratio）可在成功时向 stdout 打一行 JSON。是否如此未拍板，见开放问题。

退出码由 service 返回，本脚本 `process.exit`。

---

## 3. 职责与边界

**做**

```ts
// 设计草图，不是实现
import { runCli, parseArgv } from '../src/service/cli'

const code = await runCli(parseArgv(process.argv.slice(2)))
process.exit(code)
```

**禁止**

- 在本文件 import pipeline、agent、sqlite、pi。
- 默认启动任何 server。
- 读取整份 trace 做预览打印（那会把原文泄漏进日志；需要 debug 再加 flag）。

---

## 4. 依赖关系

```text
script/run-distill.ts → src/service/cli.ts
                     ✗ 其它 src 目录
```

`package.json` 的 `"bin"` / `"scripts"` 指向这里（工程骨架的事）。

---

## 5. 关键规则 / 算法

- 展示层只有 `--report` 产出的 html，没有 `--serve`。
- Admission / 洞 / 裁剪失败都不要在本文件用 `try/catch` 吞掉——交给 service。
- 与 [data/raw](../../data/raw/README.md)、[data/distilled](../../data/distilled/README.md) 的目录约定：默认输入可来自 raw，输出写 distilled；显式路径优先。

---

## 6. 仍开放的设计问题

1. 用 `node` 直接跑 ts 还是先 `tsc` 再跑 `dist/`：architecture 写了 tsconfig.build.json，倾向编译后跑。骨架未建。
2. stdout 一行 JSON vs 纯人类日志。
3. 是否支持 glob 批量（M3 才要批量入口，MVP 单文件）。

---

## 7. 实现完成标准

- [ ] 文件存在且只委托 service。
- [ ] `--help` 不加载 pi。
- [ ] 无 `--serve` / `listen(`。
- [ ] README 的「怎么跑」与本文件命令一致。
- [ ] **现在不创建该 ts 文件**——本任务只交文档。
