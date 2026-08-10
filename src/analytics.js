/**
 * analytics.js — renders a data-driven analytics dashboard (HTML + inline SVG)
 * from the aggregations in db.analytics(). No chart library: hand-rolled SVG so
 * it stays dependency-free and matches the report aesthetic.
 */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SEV_COLOR = { critical: '#E0533B', serious: '#E8920A', moderate: '#6B5CE7', minor: '#0EA5A0' };

function barChart(rows, { label, color = '#6B5CE7' }) {
  if (!rows.length) return `<p class="muted">No data yet.</p>`;
  const max = Math.max(...rows.map(r => r.n));
  return `<div class="bars">` + rows.map(r => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(r.key)}">${esc(r.key)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (r.n / max) * 100)}%;background:${r.color || color}"></div></div>
      <div class="bar-n">${r.n}</div>
    </div>`).join('') + `</div>`;
}

function lineChart(series) {
  const domains = Object.keys(series).filter(d => series[d].length);
  if (!domains.length) return `<p class="muted">No score history yet — scan a site more than once to see its trend.</p>`;
  const W = 640, H = 220, P = 28;
  const palette = ['#6B5CE7', '#0EA5A0', '#E8920A', '#E0533B', '#22A06B', '#C24DD6'];
  const maxLen = Math.max(...domains.map(d => series[d].length), 2);
  const x = (i, len) => P + (len <= 1 ? 0 : (i / (len - 1)) * (W - 2 * P));
  const y = v => H - P - (v / 100) * (H - 2 * P);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Score history by domain">`;
  // gridlines
  for (let g = 0; g <= 100; g += 25) svg += `<line x1="${P}" y1="${y(g)}" x2="${W - P}" y2="${y(g)}" stroke="#ECEAE3"/><text x="6" y="${y(g) + 3}" font-size="9" fill="#A8A59E">${g}</text>`;
  domains.forEach((d, di) => {
    const pts = series[d];
    const col = palette[di % palette.length];
    const path = pts.map((p, i) => `${x(i, pts.length).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
    if (pts.length > 1) svg += `<polyline points="${path}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
    pts.forEach((p, i) => { svg += `<circle cx="${x(i, pts.length).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="3.5" fill="${col}"/>`; });
  });
  svg += `</svg>`;
  const legend = domains.map((d, di) => `<span class="leg"><i style="background:${palette[di % palette.length]}"></i>${esc(d)}</span>`).join('');
  return svg + `<div class="legend">${legend}</div>`;
}

function renderAnalytics(a) {
  const t = a.totals || {};
  const ruleRows = (a.topRules || []).map(r => ({ key: r.rule_id, n: r.n }));
  const impactOrder = ['critical', 'serious', 'moderate', 'minor'];
  const impactRows = (a.impact || [])
    .sort((x, y) => impactOrder.indexOf(x.impact) - impactOrder.indexOf(y.impact))
    .map(r => ({ key: r.impact, n: r.n, color: SEV_COLOR[r.impact] || '#888' }));

  const card = (title, body) => `<section class="card"><h2>${title}</h2>${body}</section>`;
  const stat = (k, v, c) => `<div class="stat"><div class="v" style="${c ? `color:${c}` : ''}">${v}</div><div class="k">${k}</div></div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Analytics — Accessibility Monitor</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
 body{font-family:'DM Sans',sans-serif;background:#F4F3EF;color:#1C1B22;margin:0;padding:26px;}
 h1{font-family:'Syne',sans-serif;font-size:22px;margin:0 0 2px;}
 .sub{color:#7A7872;font-size:13px;margin:0 0 22px;}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;}
 .card{background:#fff;border:1px solid #E7E4DC;border-radius:16px;padding:18px 20px;box-shadow:0 1px 2px rgba(0,0,0,.04);}
 .card.wide{grid-column:1/-1;}
 h2{font-family:'Syne',sans-serif;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#5B5950;margin:0 0 14px;}
 .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-bottom:18px;}
 .stat{background:#fff;border:1px solid #E7E4DC;border-radius:14px;padding:14px 16px;text-align:center;}
 .stat .v{font-family:'Syne',sans-serif;font-size:26px;font-weight:800;}
 .stat .k{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#A8A59E;margin-top:3px;}
 .bars{display:flex;flex-direction:column;gap:9px;}
 .bar-row{display:grid;grid-template-columns:150px 1fr 34px;align-items:center;gap:10px;}
 .bar-label{font-size:12px;color:#54525E;font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
 .bar-track{background:#F0EDE6;border-radius:999px;height:14px;overflow:hidden;}
 .bar-fill{height:100%;border-radius:999px;}
 .bar-n{font-size:12px;font-weight:700;text-align:right;color:#54525E;}
 .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;}
 .leg{font-size:11.5px;color:#54525E;display:inline-flex;align-items:center;gap:6px;}
 .leg i{width:11px;height:11px;border-radius:3px;display:inline-block;}
 .muted{color:#A8A59E;font-size:13px;}
</style></head><body>
<h1>Analytics</h1>
<p class="sub">Aggregated across every scan stored in the database</p>
<div class="stats">
  ${stat('Scans', t.scans || 0)}
  ${stat('Domains', t.domains || 0)}
  ${stat('Pages audited', t.pages || 0)}
  ${stat('Violations', t.violations || 0, '#E0533B')}
  ${stat('Claude calls', t.claude_calls || 0, '#6B5CE7')}
</div>
<div class="grid">
  ${card('Score history by domain', lineChart(a.series || {}))}
  ${card('Issues by severity', barChart(impactRows, { label: 'impact' }))}
  ${card('Most common violations', barChart(ruleRows, { label: 'rule' }))}
</div>
</body></html>`;
}

module.exports = { renderAnalytics };
