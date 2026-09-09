# examples

脱敏合成小样，**不是**真实 Claude Code session。用于无洞通路演示：装好依赖后即可跑，不需要 API key。

| 文件 | 说明 |
|------|------|
| `add-fix.jsonl` | 单任务 claude-code JSONL：修 `add.ts` 使测试通过。含重复读、失败重试、一次无关死胡同、最后 pytest 通过（Ground Truth）。 |
| `add-fix.report.html` | 对上述小样跑 `--no-llm` 生成的自包含报告。双击打开即可，无服务器。 |

## 怎么再生成报告

```bash
node script/run-distill.ts distill examples/add-fix.jsonl \
  --no-llm \
  --sqlite /tmp/distiller-example.sqlite \
  --report examples/add-fix.report.html
```

`trace_id` 形如 `claude-code:sess-no-llm`。随后：

```bash
node script/run-distill.ts eval claude-code:sess-no-llm --sqlite /tmp/distiller-example.sqlite
node script/run-distill.ts report claude-code:sess-no-llm \
  --sqlite /tmp/distiller-example.sqlite \
  --out /tmp/add-fix-from-db.html
```

只读 live dump（Distiller 裁剪过程，不是对方 agent）：

```bash
node script/run-distill.ts distill examples/add-fix.jsonl \
  --no-llm \
  --live-dump /tmp/distiller-live
```

双击 `/tmp/distiller-live/live.html`（`file://`），不要起 HTTP server。默认传输是进程内 job 表 + 这份 dump；`--live-socket` 可选，默认关闭。

不要把真实 session 或密钥放进本目录。
