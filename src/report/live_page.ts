/** 页头硬文案：live = Distiller 自己的裁剪，不是对方 coding agent。 */
export const LIVE_PAGE_NOTICE = 'Distiller 裁剪过程，不是对方 agent'

/** 与 `dumpAllJobs()` 同形；report 不 import service。 */
export interface LivePageSnapshot {
  list_jobs: unknown[]
  jobs: Array<{
    list_jobs: unknown
    attach_job: { job_id?: string; trace_id?: string; status?: string }
    detach_job?: unknown
    get_cut_progress: {
      job_id?: string
      trace_id?: string
      segment?: string
      rules?: string
      holes?: string
      assemble?: string
      compression_ratio?: number
    }
    get_partial_result: {
      cards?: Array<{ id?: string; tool?: string; head?: string; sig?: string }>
    }
    get_warrant_tail: Array<{
      segment_id?: string
      action?: string
      source?: { kind?: string; name?: string }
    }>
  }>
}

/** 纯函数。禁止读盘、写盘、fetch、listen。file:// 打开。 */
export function renderLiveHtml(snapshot: LivePageSnapshot): string {
  const payload = embedJson(snapshot)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Trace Distiller · live</title>
<style>
  :root {
    --ink: #1a1f18;
    --muted: #5c6758;
    --paper: #eef2e8;
    --card: #fbfcf7;
    --line: #c9d2c0;
    --keep: #2f6f4e;
    --drop: #9a3412;
    --collapse: #92400e;
    --accent: #3d5a2c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    background: var(--paper);
    color: var(--ink);
  }
  header {
    padding: 1.6rem 1.4rem 1.1rem;
    border-bottom: 1px solid var(--line);
    background: var(--card);
  }
  h1 { font-size: 1.28rem; font-weight: 600; margin: 0 0 0.35rem; }
  .notice {
    margin: 0;
    color: var(--accent);
    font-size: 0.95rem;
  }
  .sub { color: var(--muted); font-size: 0.88rem; margin: 0.45rem 0 0; }
  .layout {
    display: grid;
    grid-template-columns: minmax(12rem, 18rem) 1fr;
    min-height: 70vh;
  }
  #job-list {
    border-right: 1px solid var(--line);
    padding: 1rem 0.9rem 2rem;
  }
  #detail { padding: 1rem 1.2rem 2rem; }
  .tag { font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
  .job {
    display: block;
    width: 100%;
    text-align: left;
    margin: 0.3rem 0;
    padding: 0.5rem 0.55rem;
    border: 1px solid var(--line);
    background: var(--card);
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .job[aria-current="true"] { outline: 2px solid var(--accent); }
  .stages {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.6rem;
    margin: 0.8rem 0 1rem;
  }
  .cell {
    background: var(--card);
    border: 1px solid var(--line);
    padding: 0.7rem 0.75rem;
  }
  .cell .num { font-size: 1.05rem; font-variant-numeric: tabular-nums; margin-top: 0.25rem; }
  .ratio {
    background: var(--card);
    border: 1px solid var(--line);
    padding: 0.7rem 0.85rem;
    margin-bottom: 1rem;
  }
  .card, .warrant {
    background: var(--card);
    border: 1px solid var(--line);
    padding: 0.45rem 0.55rem;
    margin: 0.35rem 0;
  }
  .warrant[data-action="keep"] { border-left: 4px solid var(--keep); }
  .warrant[data-action="drop"] { border-left: 4px solid var(--drop); }
  .warrant[data-action="collapse"] { border-left: 4px solid var(--collapse); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
  @media (max-width: 720px) {
    .layout { grid-template-columns: 1fr; }
    #job-list { border-right: 0; border-bottom: 1px solid var(--line); }
    .stages { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
<header>
  <h1>Distiller live</h1>
  <p class="notice">${escapeHtml(LIVE_PAGE_NOTICE)}</p>
  <p class="sub">只读快照 · file:// 打开 · 无干预 · M1 进程内 job 表 dump，不是 HTTP 订阅</p>
</header>
<div class="layout">
  <aside id="job-list">
    <div class="tag">job 列表</div>
    <div id="job-rows"></div>
  </aside>
  <main id="detail">
    <div class="tag">进度四格</div>
    <div class="stages" id="stages">
      <div class="cell" data-stage="segment"><div class="tag">切段</div><div class="num" id="st-segment">—</div></div>
      <div class="cell" data-stage="rules"><div class="tag">规则</div><div class="num" id="st-rules">—</div></div>
      <div class="cell" data-stage="holes"><div class="tag">洞</div><div class="num" id="st-holes">—</div></div>
      <div class="cell" data-stage="assemble"><div class="tag">组装</div><div class="num" id="st-assemble">—</div></div>
    </div>
    <div class="ratio">压缩率 <strong id="compression" data-compression-ratio="">—</strong>
      · job <code id="job-id"></code> · trace <code id="trace-id"></code></div>
    <div class="tag">Partial Playback 卡片</div>
    <div id="playback"></div>
    <div class="tag">CutWarrant 尾（keep / drop）</div>
    <div id="warrant"></div>
  </main>
</div>
<script type="application/json" id="live-data">${payload}</script>
<script>
(function () {
  var el = document.getElementById('live-data');
  var dump = JSON.parse(el.textContent);
  var jobs = dump.jobs || [];
  var rows = document.getElementById('job-rows');
  var selected = jobs[0] || null;

  function summaryOf(snap) {
    return snap.attach_job || snap.detach_job || (snap.list_jobs && snap.list_jobs[0]) || {};
  }

  function renderList() {
    rows.textContent = '';
    if (jobs.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'sub';
      empty.textContent = '没有可观察的 Distiller job。';
      rows.appendChild(empty);
      return;
    }
    jobs.forEach(function (snap) {
      var s = summaryOf(snap);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'job';
      btn.setAttribute('data-job-id', s.job_id || '');
      if (selected && summaryOf(selected).job_id === s.job_id) btn.setAttribute('aria-current', 'true');
      btn.textContent = (s.job_id || '?') + ' · ' + (s.trace_id || '') + ' · ' + (s.status || '');
      btn.addEventListener('click', function () {
        selected = snap;
        renderList();
        renderDetail();
      });
      rows.appendChild(btn);
    });
  }

  function setStage(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value || '—';
  }

  function renderDetail() {
    var playback = document.getElementById('playback');
    var warrant = document.getElementById('warrant');
    playback.textContent = '';
    warrant.textContent = '';
    if (!selected) {
      setStage('st-segment', '—');
      setStage('st-rules', '—');
      setStage('st-holes', '—');
      setStage('st-assemble', '—');
      document.getElementById('compression').textContent = '—';
      document.getElementById('job-id').textContent = '';
      document.getElementById('trace-id').textContent = '';
      return;
    }
    var p = selected.get_cut_progress || {};
    setStage('st-segment', p.segment);
    setStage('st-rules', p.rules);
    setStage('st-holes', p.holes);
    setStage('st-assemble', p.assemble);
    var ratio = p.compression_ratio;
    var ratioEl = document.getElementById('compression');
    ratioEl.textContent = ratio === undefined || ratio === null ? '—' : String(ratio);
    ratioEl.setAttribute('data-compression-ratio', ratioEl.textContent);
    document.getElementById('job-id').textContent = p.job_id || summaryOf(selected).job_id || '';
    document.getElementById('trace-id').textContent = p.trace_id || summaryOf(selected).trace_id || '';

    var cards = (selected.get_partial_result && selected.get_partial_result.cards) || [];
    if (cards.length === 0) {
      var none = document.createElement('p');
      none.className = 'sub';
      none.textContent = '没有 Playback 卡片。';
      playback.appendChild(none);
    }
    cards.forEach(function (card) {
      var div = document.createElement('div');
      div.className = 'card';
      div.setAttribute('data-segment-id', card.id || '');
      div.textContent = (card.id || '') + ' · ' + (card.tool || '') + ' · ' + (card.head || card.sig || '');
      playback.appendChild(div);
    });

    var tail = selected.get_warrant_tail || [];
    tail.forEach(function (entry) {
      var div = document.createElement('div');
      div.className = 'warrant';
      div.setAttribute('data-action', entry.action || '');
      div.setAttribute('data-segment-id', entry.segment_id || '');
      var src = entry.source ? (entry.source.kind + ':' + entry.source.name) : '';
      div.textContent = (entry.action || '') + ' · ' + (entry.segment_id || '') + ' · ' + src;
      warrant.appendChild(div);
    });
  }

  renderList();
  renderDetail();
})();
</script>
</body>
</html>
`
}

function embedJson(model: LivePageSnapshot): string {
  return JSON.stringify(model).replace(/</g, '\\u003c')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
