import type { LabelDecision } from '../domain/label_decision.ts'
import type { IntentHypothesis } from '../types/agent_view.ts'
import type { PlaybackCut } from '../types/cut_plan.ts'
import type { CutWarrant } from '../types/cut_warrant.ts'
import type { TraceMeta } from '../types/raw_trace.ts'
import type { SegmentCard } from '../types/segment.ts'

export interface ReportCoverage {
  total: number
  ruled: number
  llm: number
  fail_closed: number
}

export interface ReportMetrics {
  compression_ratio: number
  distill_cost_ratio: number
  llm_segment_fraction: number
}

export interface ReportModel {
  meta: TraceMeta
  intent: IntentHypothesis
  original_step_count: number
  kept_step_count: number
  /** 左栏原始卡片索引；未拍板是否内嵌全文。 */
  segments: SegmentCard[]
  playback: PlaybackCut
  warrant: CutWarrant
  labels: LabelDecision[]
  coverage: ReportCoverage
  metrics: ReportMetrics
  baseline?: { distill_cost_ratio: number }
}

/** 纯函数。禁止读盘、禁止写盘、禁止 fetch。 */
export function renderHtml(model: ReportModel): string {
  const payload = embedJson(model)
  const compression = String(model.metrics.compression_ratio)
  const ruled = String(model.coverage.ruled)
  const llmFrac = String(model.metrics.llm_segment_fraction)
  const cost = String(model.metrics.distill_cost_ratio)
  const original = String(model.original_step_count)
  const kept = String(model.kept_step_count)
  const intentText = escapeHtml(model.intent.text.length > 0 ? model.intent.text : '（无洞：意图未推断）')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Trace Distiller · ${escapeHtml(model.meta.trace_id)}</title>
<style>
  :root {
    --ink: #1c1915;
    --muted: #6b6459;
    --paper: #f4efe6;
    --card: #fffdf8;
    --line: #d9d0c3;
    --keep: #2f6f4e;
    --drop: #9a3412;
    --collapse: #92400e;
    --rule: #1e3a5f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    background: var(--paper);
    color: var(--ink);
  }
  header#hero {
    padding: 2.2rem 1.5rem 1.5rem;
    border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.4rem; }
  .sub { color: var(--muted); font-size: 0.95rem; }
  .lens {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-top: 1.2rem;
  }
  .wall, .essence, .cost {
    background: var(--card);
    border: 1px solid var(--line);
    padding: 1rem 1.1rem;
  }
  .num { font-size: 2.4rem; font-variant-numeric: tabular-nums; letter-spacing: -0.03em; }
  #coverage { margin-top: 1rem; }
  main {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    min-height: 50vh;
  }
  #original-index, #playback-seq {
    padding: 1rem 1.2rem 2rem;
  }
  #original-index { border-right: 1px solid var(--line); }
  button.seg {
    display: block;
    width: 100%;
    text-align: left;
    margin: 0.35rem 0;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--line);
    background: var(--card);
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  button.seg[data-action="drop"] { border-left: 4px solid var(--drop); }
  button.seg[data-action="collapse"] { border-left: 4px solid var(--collapse); }
  button.seg[data-action="keep"] { border-left: 4px solid var(--keep); }
  #cut-detail {
    grid-column: 1 / -1;
    padding: 1rem 1.2rem 2rem;
    border-top: 1px solid var(--line);
    background: #efe8dc;
    min-height: 6rem;
  }
  #eval-panel, #metrics-footer {
    padding: 1rem 1.2rem 1.6rem;
    border-top: 1px solid var(--line);
  }
  .tag { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
</style>
</head>
<body>
<header id="hero">
  <h1>500 步的墙 → 精华</h1>
  <p class="sub">trace <code>${escapeHtml(model.meta.trace_id)}</code> · 意图 ${intentText}</p>
  <div class="lens">
    <div class="wall" id="wall">
      <div class="tag">原始步数墙</div>
      <div class="num" data-original-steps="${escapeHtml(original)}">${escapeHtml(original)}</div>
    </div>
    <div class="essence" id="essence">
      <div class="tag">精华步数</div>
      <div class="num" data-kept-steps="${escapeHtml(kept)}">${escapeHtml(kept)}</div>
    </div>
  </div>
  <div class="cost" id="coverage">
    <div class="tag">规则覆盖 / 处理成本</div>
    <p>压缩率 <strong data-compression-ratio="${escapeHtml(compression)}">${escapeHtml(compression)}</strong>
       · 规则已定 <strong data-ruled="${escapeHtml(ruled)}">${escapeHtml(ruled)}</strong> / ${escapeHtml(String(model.coverage.total))}
       · LLM 段比例 <strong data-llm-fraction="${escapeHtml(llmFrac)}">${escapeHtml(llmFrac)}</strong>
       · 蒸馏成本比 <strong data-distill-cost="${escapeHtml(cost)}">${escapeHtml(cost)}</strong>
       · Fail-Closed ${escapeHtml(String(model.coverage.fail_closed))}</p>
  </div>
</header>
<main>
  <section id="original-index">
    <div class="tag">原始卡片索引</div>
    <div id="original-list"></div>
  </section>
  <section id="playback-seq">
    <div class="tag">Playback 序列</div>
    <div id="playback-list"></div>
  </section>
  <section id="cut-detail">
    <div class="tag">点开删除 / 压缩</div>
    <p id="cut-detail-body">点左侧 drop / collapse 段，查看凭证 source 与理由。</p>
  </section>
</main>
<section id="eval-panel">
  <div class="tag">盲测结论</div>
  <p>未跑 eval</p>
</section>
<footer id="metrics-footer">
  <div class="tag">收尾两个数字</div>
  <p>压缩率 ${escapeHtml(compression)} · 处理成本比 ${escapeHtml(cost)}</p>
</footer>
<script type="application/json" id="report-data">${payload}</script>
<script>
(function () {
  var el = document.getElementById('report-data');
  var model = JSON.parse(el.textContent);
  var byId = {};
  (model.segments || []).forEach(function (s) { byId[s.id] = s; });
  var labels = {};
  (model.labels || []).forEach(function (d) { labels[d.segment_id] = d; });
  var orig = document.getElementById('original-list');
  var play = document.getElementById('playback-list');
  var detail = document.getElementById('cut-detail-body');

  function sourceText(entry) {
    if (!entry || !entry.source) return '';
    return (entry.source.kind || '') + ':' + (entry.source.name || '');
  }

  (model.warrant.entries || []).forEach(function (entry) {
    var card = byId[entry.segment_id] || {};
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg';
    btn.setAttribute('data-action', entry.action);
    btn.setAttribute('data-segment-id', entry.segment_id);
    btn.setAttribute('data-source', sourceText(entry));
    btn.textContent = entry.action + ' · ' + entry.segment_id + ' · ' + (card.head || card.sig || '');
    btn.addEventListener('click', function () {
      var lines = [
        'segment ' + entry.segment_id,
        'action ' + entry.action,
        'source ' + sourceText(entry),
        'confidence ' + String(entry.confidence)
      ];
      if (entry.dead_end_summary) lines.push('dead_end: ' + entry.dead_end_summary);
      var lab = labels[entry.segment_id];
      if (lab) lines.push('label ' + lab.label + ' (' + (lab.rule_name || lab.source.name) + ')');
      detail.textContent = lines.join('\\n');
    });
    orig.appendChild(btn);
  });

  (model.playback.cards || []).forEach(function (card) {
    var p = document.createElement('p');
    p.className = 'seg-keep';
    p.textContent = 'keep · ' + card.id + ' · ' + (card.head || card.sig || '');
    play.appendChild(p);
  });
  (model.playback.collapsed || []).forEach(function (c) {
    var p = document.createElement('p');
    p.className = 'seg-collapse';
    p.textContent = 'collapse · ' + c.segment_id + ' · ' + (c.summary || '');
    play.appendChild(p);
  });
})();
</script>
</body>
</html>
`
}

function embedJson(model: ReportModel): string {
  return JSON.stringify(model).replace(/</g, '\\u003c')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
