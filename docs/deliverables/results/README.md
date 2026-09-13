# 记分板归档

这些表从本机 `benchmark/out*` 抄入。源目录被 [`.gitignore`](../../../.gitignore) 忽略（`benchmark/out/`、`benchmark/out-*/`），**从未作为 git 对象入库**。因此每份只保证：本地 mtime、当时命令、以及能对上的仓库提交。无法从 git 检出「生成记分板的那次 blob」。

**Fake** = `--fake-l4` / `FakeSessionBackend`（过程门禁夹具）。**real mint** = `--with-l4` + 本机 OpenAI-compatible 网关（密钥不进本包）。

| 文件 | 标签 | 本地 mtime (+08) | 仓库锚点 | 源路径 |
|------|------|------------------|----------|--------|
| [fake-m1-2026-09-13.md](./fake-m1-2026-09-13.md) | Fake | 2026-09-13 22:41:23 | HEAD `9b1c2b8`（merge PR #65） | `benchmark/out/scoreboard.md` |
| [mint-short-2026-09-11.md](./mint-short-2026-09-11.md) | real mint | 2026-09-11 14:13:39 | 邻近 `f4c5cf9` 之后、`c656c49` 之前 | `benchmark/out-mint/scoreboard.md` |
| [mint-post37-slim-2026-09-11.md](./mint-post37-slim-2026-09-11.md) | real mint | 2026-09-11 16:10:44 | 邻近 `c656c49`（mint 根因 + MIMO 接入） | `benchmark/out-mint-post37-slim/scoreboard.md` |
| [long-mint-2026-09-12.md](./long-mint-2026-09-12.md) | real mint | 2026-09-12 04:47:39 | 邻近 `be95a1d`（QA near-JSON 软修复）之后 | `benchmark/out-long-mint/scoreboard.md` |
| [long-smoke-2026-09-11.md](./long-smoke-2026-09-11.md) | 历史对照 | 2026-09-11 17:28:30 | 邻近 `e30d2c0`（CutProfile 阀门） | `benchmark/out-long-smoke/scoreboard.md` |

`9b1c2b8` = `Merge pull request #65`（ADR-0013 P0 预算对齐 harness）。功能提交 `3ad58c8`。Fake 板在 merge 后约 4 分钟写出。

历史 mint 板早于 ADR-0014（`910363d`，2026-09-12 19:21 +08）：fail 样本的 composite/m1 仍可能印成 `0.00`。现行口径是 `—` / JSON `null`。

[long-smoke](./long-smoke-2026-09-11.md) 的 JSON `mode` 为当时的 `no_llm`。现行 CLI 已删除该路径（ADR-0010），传入即报错。该文件只说明「无洞时 MIMO 几乎不压缩」，**不是**可复现命令。
