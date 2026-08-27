# data/distilled

剪辑产物输出目录。

约定（M2 起严格执行；M1 可先写中间表示）：

- `*-training.*`：Training Cut（SFT 格式）
- `*-playback.*`：Playback Cut（导演剪辑版）
- 同一次运行的两份产物应共享同一标签与保留集（见 ADR-0003）

真实产物默认不入库。
