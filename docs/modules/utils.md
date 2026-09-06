# utils — 无状态小函数

对应路径：`src/utils/`。architecture：**仅** token 估算、jsonl 读写、logger。状态相关的一律进 domain / data，不许堆 utils。

---

## 1. 目的 / 非目标

**目的**

- 给 adapters / segmenter / eval 提供没有业务含义的纯工具。
- token 估算在压缩率口径拍板前也可以存在，但必须标明「估算」还是「官方口径」。

**非目标**

- 不是第二 domain 层。出现 `Label` / `CutPlan` / `AgentView` 的函数就不该在 utils。
- 不持有全局可变配置对象（profile 从调用方传入）。
- 不做 pi wrapper（那是 sessions）。
- 不封装 sqlite。
- 不写「万能 `helpers.ts`」。

---

## 2. 输入输出

```ts
/** jsonl.ts */
function readJsonl(path: string): unknown[]
function writeJsonl(path: string, rows: unknown[]): void

/** tokens.ts */
function estimateTokens(text: string): number
/** 官方口径函数：口径 P0 未定之前不要冒充 compressionRatio 的唯一实现 */

/** logger.ts */
function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void
```

允许少量路径/哈希：`stableHash(s: string): string`（给 trace_id），仍须无状态。

---

## 3. 职责与边界

**做**

- 无业务分支的字符串、文件、计数。

**禁止**

- 读 CutProfile 决定怎么估 token。
- 缓存「上一条 trace」。
- 在 logger 里写 SQLite 审计表（要记就走 data）。
- 把规则函数 `isRepeatRead` 塞进来。

---

## 4. 依赖关系

```text
utils → 标准库 only（可依赖极薄的第三方 tokenizer，若引入须在本文件注明）
     ← adapters, segmenter, service, eval, data（路径拼接）
     ✗ types 里的业务对象作为必需输入（读 jsonl 返回 unknown，调用方去校验）
```

utils **不要**依赖 pipeline / agent / domain。domain 也不该依赖 utils；token 估算若 domain 需要，让调用方把 number 传进去。

---

## 5. 关键规则 / 算法

- 分层纪律原话：状态相关的一律进 domain / data。
- jsonl 是 I/O 格式（architecture 存储选型），不是领域模型。
- token 估算算法（字符/4、tiktoken、pi 自带）会改变压缩率绝对值——**必须单一实现**。在 P0 口径关闭前，函数名用 `estimateTokens`，eval 的 compressionRatio 文档注明「当前为估算」。

---

## 6. 仍开放的设计问题

1. **官方 tokenizer**（P0 口径的一部分）。
2. logger 打到 stderr 还是文件；MVP 建议 stderr，避免又一个隐式状态文件。
3. 是否允许 `utils/fs.ts` 超出 jsonl（读任意文本）。建议 adapters 用 jsonl + `readFile` 自管，不扩张 utils。

---

## 7. 实现完成标准

- [ ] 目录不超过 architecture 点名的三类 + 必要的 hash。
- [ ] 无 Label/Warrant 字样。
- [ ] `estimateTokens` 对同一字符串稳定。
- [ ] jsonl 读写 round-trip 单测。
- [ ] 无 sqlite、无 pi。
