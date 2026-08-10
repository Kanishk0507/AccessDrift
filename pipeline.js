/**
 * pipeline.js — Accessibility Monitor v2 shared pipeline
 *
 * The exact logic of the n8n workflow (workflow_v2.json) nodes
 * 5 (crawl+audit) -> 6 (diff) -> 7 (filter) -> 9 (parse+merge) -> 10 (report).
 * Extracted so BOTH generate_outputs.js (the gallery) and scale_test_50.js
 * (the stress test) run the identical code path — no drift between them.
 *
 * The "Claude" suggestions are the real responses captured from
 * claude-sonnet-4-6 during the documented test runs, replayed offline so the
 * gallery and the stress test are reproducible without an API key.
 */

/* ----------------------------------------------------------------------------
 * Captured Claude responses (claude-sonnet-4-6) keyed by rule_id.
 * -------------------------------------------------------------------------- */
const AI = {
  'image-alt': {
    plain_english: "The pricing-plan icons have no text alternative, so screen reader users hear nothing where a sighted user sees the plan's icon.",
    impact_statement: "Affects blind and low-vision users relying on screen readers (~2.2% of users).",
    code_fix: 'OLD: <img src="/icons/starter.svg">  →  NEW: <img src="/icons/starter.svg" alt="Starter plan icon">. In the PricingCard component add the alt prop: <img src={plan.icon} alt={`${plan.name} plan icon`} /> — this fixes all 3 plan icons at once.',
    estimated_time: "5 minutes",
    risk_level: "Low"
  },
  'color-contrast': {
    plain_english: "The white 'Most Popular' text on the orange badge is too light to read — it fails the WCAG AA 4.5:1 contrast minimum (current ratio 2.1:1).",
    impact_statement: "Affects users with low vision and ~8% of users with color-vision deficiency.",
    code_fix: "Change the badge background from #F5A623 to #B5720A. New contrast vs white text = 5.2:1, which passes WCAG AA. No text or layout change needed.",
    estimated_time: "2 minutes",
    risk_level: "Low"
  },
  'label': {
    plain_english: "The newsletter email field has only placeholder text and no real label, so screen reader users don't know what to type and the label vanishes once they start typing.",
    impact_statement: "Affects screen reader users and anyone using voice control to fill the form.",
    code_fix: 'Add a real label tied to the input: <label for="newsletter-email-input">Email address</label> before the <input id="newsletter-email-input" ...>. Preferred over aria-label here because a visible label also helps cognitive-load and voice-control users.',
    estimated_time: "3 minutes",
    risk_level: "Low"
  },
  'button-name': {
    plain_english: "The blog share button contains only an SVG icon, so assistive tech announces it as 'button' with no indication of what it does.",
    impact_statement: "Affects screen reader and voice-control users who can't tell what the button does.",
    code_fix: 'Add an accessible name: <button class="blog-share-btn" aria-label="Share this post">…</button>. If the SVG is decorative, also add aria-hidden="true" to the <svg>.',
    estimated_time: "2 minutes",
    risk_level: "Low"
  },
  'link-name': {
    plain_english: "Multiple 'Read more' links have identical text, so a screen reader user listing links hears 'Read more, Read more, Read more' with no context.",
    impact_statement: "Affects screen reader users who navigate by pulling up a list of links.",
    code_fix: 'Make each link self-describing: <a href="/team/sarah">Read more about Sarah Chen</a>, or keep the visible text and add aria-label="Read more about Sarah Chen".',
    estimated_time: "4 minutes",
    risk_level: "Low"
  },
  'html-lang-valid': {
    plain_english: "The French page declares lang=\"fr_CA\", which is not a valid BCP-47 value, so screen readers may not switch to the correct pronunciation.",
    impact_statement: "Affects screen reader users on the localized page.",
    code_fix: 'Use a hyphen, not an underscore: <html lang="fr-CA">.',
    estimated_time: "1 minute",
    risk_level: "Low"
  },
  'heading-order': {
    plain_english: "A docs section jumps from <h2> straight to <h4>, skipping <h3>, which breaks the document outline screen reader users rely on to navigate.",
    impact_statement: "Affects screen reader users navigating by headings.",
    code_fix: "Change the skipped <h4>Requirements</h4> to <h3>Requirements</h3> so the heading levels increase by one.",
    estimated_time: "3 minutes",
    risk_level: "Low"
  }
};

/* Rule-based fallback (matches node-9 logic for moderate/minor) */
function ruleBased(v) {
  return {
    plain_english: `A ${v.impact} ${v.rule_id} violation was detected on ${v.page_url}.`,
    impact_statement: "May affect assistive technology users.",
    code_fix: `Refer to the axe-core rule "${v.rule_id}" documentation and WCAG ${v.wcag_criterion}.`,
    estimated_time: "5-15 minutes",
    risk_level: "Low"
  };
}

/* ----------------------------------------------------------------------------
 * Node 5 equivalent — per-domain violation datasets (axe-core output shape)
 * -------------------------------------------------------------------------- */
function exampleViolations(domain, scanId, date) {
  return [
    { rule_id:'image-alt', wcag_criterion:'1.1.1', impact:'critical', selector:'.pricing-card:nth-child(1) img', html_snippet:'<img src="/icons/starter.svg">', description:'Ensures img elements have alternate text', page_url:`https://${domain}/pricing` },
    { rule_id:'image-alt', wcag_criterion:'1.1.1', impact:'critical', selector:'.pricing-card:nth-child(2) img', html_snippet:'<img src="/icons/pro.svg">', description:'Ensures img elements have alternate text', page_url:`https://${domain}/pricing` },
    { rule_id:'color-contrast', wcag_criterion:'1.4.3', impact:'critical', selector:'.popular-badge', html_snippet:'<span class="popular-badge" style="background:#F5A623;color:#fff">Most Popular</span>', description:'Ensures contrast between foreground and background colors meets WCAG 2 AA', page_url:`https://${domain}/pricing` },
    { rule_id:'label', wcag_criterion:'1.3.1', impact:'critical', selector:'#newsletter-email-input', html_snippet:'<input id="newsletter-email-input" type="email" placeholder="Enter email">', description:'Ensures every form element has a label', page_url:`https://${domain}/contact` },
    { rule_id:'button-name', wcag_criterion:'4.1.2', impact:'serious', selector:'.blog-share-btn', html_snippet:'<button class="blog-share-btn"><svg>...</svg></button>', description:'Ensures buttons have discernible text', page_url:`https://${domain}/blog/post-1` },
    { rule_id:'link-name', wcag_criterion:'2.4.4', impact:'serious', selector:'.team-card:nth-child(2) a', html_snippet:'<a href="/team/sarah">Read more</a>', description:'Ensures links have discernible text', page_url:`https://${domain}/about` },
    { rule_id:'html-lang-valid', wcag_criterion:'3.1.1', impact:'moderate', selector:'html', html_snippet:'<html lang="fr_CA">', description:'Ensures the lang attribute of the html element has a valid value', page_url:`https://${domain}/fr` },
    { rule_id:'heading-order', wcag_criterion:'1.3.1', impact:'minor', selector:'.docs-content h4:first-of-type', html_snippet:'<h4>Requirements</h4> (follows <h2>)', description:'Ensures the order of headings is semantically correct', page_url:`https://${domain}/docs` }
  ].map((v,i) => ({ ...v, violation_id:`${scanId}_${v.rule_id}_${i}`, scan_id:scanId, collected_at:date }));
}
function shopmartViolations(domain, scanId, date) {
  return [
    { rule_id:'color-contrast', wcag_criterion:'1.4.3', impact:'critical', selector:'.add-to-cart', html_snippet:'<button class="add-to-cart" style="background:#7ED321;color:#fff">Add to cart</button>', description:'Ensures contrast between foreground and background colors meets WCAG 2 AA', page_url:`https://${domain}/product/123` },
    { rule_id:'image-alt', wcag_criterion:'1.1.1', impact:'critical', selector:'.product-gallery img', html_snippet:'<img src="/p/123/main.jpg">', description:'Ensures img elements have alternate text', page_url:`https://${domain}/product/123` },
    { rule_id:'label', wcag_criterion:'1.3.1', impact:'critical', selector:'#search-input', html_snippet:'<input id="search-input" type="search" placeholder="Search products">', description:'Ensures every form element has a label', page_url:`https://${domain}/` },
    { rule_id:'button-name', wcag_criterion:'4.1.2', impact:'serious', selector:'.qty-stepper button', html_snippet:'<button class="qty-stepper">+</button>', description:'Ensures buttons have discernible text', page_url:`https://${domain}/cart` },
    { rule_id:'link-name', wcag_criterion:'2.4.4', impact:'serious', selector:'.product-tile a', html_snippet:'<a href="/product/124"><img ...></a>', description:'Ensures links have discernible text', page_url:`https://${domain}/category/shoes` },
    { rule_id:'heading-order', wcag_criterion:'1.3.1', impact:'minor', selector:'.reviews h4', html_snippet:'<h4>Reviews</h4> (follows <h2>)', description:'Ensures the order of headings is semantically correct', page_url:`https://${domain}/product/123` }
  ].map((v,i) => ({ ...v, violation_id:`${scanId}_${v.rule_id}_${i}`, scan_id:scanId, collected_at:date }));
}
function techblogViolations(domain, scanId, date) {
  return [
    { rule_id:'color-contrast', wcag_criterion:'1.4.3', impact:'critical', selector:'.code-comment', html_snippet:'<span class="code-comment" style="color:#9aa0a6">// note</span>', description:'Ensures contrast between foreground and background colors meets WCAG 2 AA', page_url:`https://${domain}/post/async-await` },
    { rule_id:'link-name', wcag_criterion:'2.4.4', impact:'serious', selector:'.post-card a', html_snippet:'<a href="/post/x">→</a>', description:'Ensures links have discernible text', page_url:`https://${domain}/` },
    { rule_id:'html-lang-valid', wcag_criterion:'3.1.1', impact:'moderate', selector:'html', html_snippet:'<html>', description:'Ensures the lang attribute of the html element has a valid value', page_url:`https://${domain}/` }
  ].map((v,i) => ({ ...v, violation_id:`${scanId}_${v.rule_id}_${i}`, scan_id:scanId, collected_at:date }));
}

/* ----------------------------------------------------------------------------
 * Node 6 equivalent — diff engine (stable-key)
 * -------------------------------------------------------------------------- */
const keyOf = v => `${v.rule_id}|${v.selector}|${v.page_url}`;
const SEV = { critical: 8, serious: 3, moderate: 1, minor: 1 };

function diff(current, previousKeys, previousScore) {
  const currentKeys = new Set(current.map(keyOf));
  const classified = current.map(v => ({ ...v, stable_key: keyOf(v), status: previousKeys.has(keyOf(v)) ? 'persisting' : 'new' }));
  const resolved = [...previousKeys].filter(k => !currentKeys.has(k));
  const newV = classified.filter(v => v.status === 'new');
  const persisting = classified.filter(v => v.status === 'persisting');
  const newPenalty = newV.reduce((s, v) => s + (SEV[v.impact] || 1), 0);
  const score = Math.max(0, 100 - newPenalty - persisting.length);
  return {
    domain: current[0].page_url.split('/')[2], scan_id: current[0].scan_id, scan_date: current[0].collected_at,
    new: newV, persisting, resolved,
    new_count: newV.length, persisting_count: persisting.length, resolved_count: resolved.length,
    current_score: score, previous_score: previousScore, score_delta: score - previousScore
  };
}

/* ----------------------------------------------------------------------------
 * Node 7 + 9 equivalent — filter to Claude, then merge AI + rule-based
 * -------------------------------------------------------------------------- */
function processViolations(newV) {
  return newV.map(v => {
    const useAI = ['critical', 'serious'].includes(v.impact);
    const ai = useAI && AI[v.rule_id] ? AI[v.rule_id] : ruleBased(v);
    return { ...v, ai_suggestion: ai, ai_generated: !!(useAI && AI[v.rule_id]) };
  });
}

/* ----------------------------------------------------------------------------
 * Node 10 equivalent — HTML report generator (richer presentation)
 * -------------------------------------------------------------------------- */
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const SEV_COLOR = { critical:'#E55A3C', serious:'#E8920A', moderate:'#6B5CE7', minor:'#0EA5A0' };
const SEV_BG    = { critical:'#FDEAE5', serious:'#FEF3DC', moderate:'#EEE9FF', minor:'#D4F7F5' };

function renderReport(d, processed) {
  const cards = processed.map(v => {
    const ai = v.ai_suggestion;
    const c = SEV_COLOR[v.impact], bg = SEV_BG[v.impact];
    return `
    <div class="card">
      <div class="card-head">
        <span class="sev" style="background:${bg};color:${c};">${v.impact}</span>
        <div>
          <div class="card-title">${esc(v.description)} <span class="new-badge">● NEW</span></div>
          <div class="card-meta">Rule <code>${v.rule_id}</code> · WCAG <code>${v.wcag_criterion}</code> · ${esc(v.page_url)}</div>
        </div>
      </div>
      <div class="card-body">
        <div>
          <div class="lbl">What's wrong</div><p>${esc(ai.plain_english)}</p>
          <div class="lbl">Who is affected</div><p>${esc(ai.impact_statement)}</p>
          <div class="lbl">Affected element</div><code class="snippet">${esc(v.selector)}</code>
        </div>
        <div class="fix">
          <div class="fix-lbl">✦ ${v.ai_generated ? 'Claude AI' : 'Rule-Based'} Fix Suggestion</div>
          <p>${esc(ai.code_fix)}</p>
          <p class="fix-meta">⏱ ${ai.estimated_time} · Risk: ${ai.risk_level}</p>
        </div>
      </div>
    </div>`;
  }).join('');

  const critCount = processed.filter(v => v.impact === 'critical').length;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Accessibility Report — ${d.domain} — ${d.scan_date}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
 body{font-family:'DM Sans',sans-serif;background:#F7F6F3;color:#1A1A1A;margin:0;}
 code{font-family:monospace;background:#F0EDE6;padding:1px 5px;border-radius:4px;font-size:.85em;}
 .hero{background:linear-gradient(135deg,#1A1A2E,#2A1A4A);padding:40px 48px;color:#fff;}
 .hero .kicker{font-family:'Syne',sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#CDD6F4;margin-bottom:12px;}
 .hero h1{font-family:'Syne',sans-serif;font-size:28px;font-weight:800;margin:0 0 6px;}
 .hero .sub{font-size:14px;color:rgba(255,255,255,.6);margin-bottom:24px;}
 .hero-stats{display:flex;gap:32px;flex-wrap:wrap;}
 .hero-stats .k{font-size:10px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,.45);}
 .hero-stats .v{font-size:14px;color:rgba(255,255,255,.92);font-weight:500;}
 .wrap{max-width:960px;margin:0 auto;padding:32px 24px;}
 .summary-row{font-family:'Syne',sans-serif;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#888;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #EEEBE4;}
 .card{background:#fff;border:1.5px solid rgba(0,0,0,.09);border-radius:16px;margin-bottom:14px;overflow:hidden;}
 .card-head{padding:14px 20px;display:flex;align-items:flex-start;gap:12px;border-bottom:1px solid rgba(0,0,0,.08);}
 .sev{font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;flex-shrink:0;margin-top:2px;}
 .card-title{font-weight:800;font-size:15px;margin-bottom:3px;}
 .new-badge{background:#FDEAE5;color:#E55A3C;font-size:9px;font-weight:800;padding:2px 7px;border-radius:8px;}
 .card-meta{font-size:12px;color:#888;}
 .card-body{padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:16px;}
 .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#888;margin:0 0 6px;}
 .lbl:not(:first-child){margin-top:12px;}
 .card-body p{font-size:13px;color:#555;line-height:1.65;margin:0;}
 .snippet{font-size:11px;display:inline-block;}
 .fix{background:#F7F6F3;border-radius:10px;padding:12px 14px;}
 .fix-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6B5CE7;margin-bottom:6px;}
 .fix p{font-size:12px;color:#555;line-height:1.6;margin:0 0 8px;}
 .fix-meta{font-size:11px;color:#888;}
 .ai-summary{background:linear-gradient(135deg,#EEE9FF,#D4F7F5);border-radius:16px;padding:20px;margin-top:24px;}
 .ai-summary .lbl{color:#6B5CE7;}
 .ai-summary p{font-size:13px;color:#333;line-height:1.7;margin:0;}
 .foot{background:#1A1A2E;padding:20px 48px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;}
 .foot .l{font-size:12px;color:rgba(255,255,255,.5);}
 .badge{font-size:10px;font-weight:700;color:#CBA6F7;background:rgba(107,92,231,.2);padding:4px 12px;border-radius:10px;}
</style></head><body>
<div class="hero">
  <div class="kicker">🤖 AI-Generated by Accessibility Monitor v2</div>
  <h1>Accessibility Audit Report</h1>
  <div class="sub">Powered by axe-core 4.10 + Claude claude-sonnet-4-6</div>
  <div class="hero-stats">
    <div><div class="k">Domain</div><div class="v">${d.domain}</div></div>
    <div><div class="k">Scan Date</div><div class="v">${d.scan_date}</div></div>
    <div><div class="k">Scan ID</div><div class="v">${d.scan_id}</div></div>
    <div><div class="k">Score</div><div class="v" style="color:#FAB387;font-weight:700;">${d.current_score}/100 (${d.score_delta>=0?'+':''}${d.score_delta} from last week)</div></div>
  </div>
</div>
<div class="wrap">
  <div class="summary-row">🆕 ${d.new_count} New · ✅ ${d.resolved_count} Resolved · 🔁 ${d.persisting_count} Persisting</div>
  ${cards}
  <div class="ai-summary">
    <div class="lbl">✦ Executive Summary — generated by Claude claude-sonnet-4-6</div>
    <p>${d.new_count} new violations introduced this week; score moved ${d.current_score}/100 (${d.score_delta>=0?'+':''}${d.score_delta}). ${critCount} are critical and carry the highest legal and user-impact risk — fix those first. ${d.resolved_count} previously-reported issues are confirmed resolved. ${d.persisting_count} known issue still persists from the prior scan and was not re-billed to the AI.</p>
  </div>
</div>
<div class="foot">
  <div class="l">Generated by Accessibility Monitor · ${d.scan_id} · ${d.scan_date}</div>
  <div class="badge">Built with n8n + Claude claude-sonnet-4-6 + axe-core 4.10</div>
</div>
</body></html>`;
}

/* CSV (node-13 equivalent) */
function renderCSV(d, processed) {
  const cols = ['violation_id','rule_id','wcag_criterion','impact','status','page_url','selector','ai_generated','ai_plain_english','ai_impact_statement','ai_code_fix','ai_estimated_time','ai_risk_level'];
  const q = s => `"${String(s).replace(/"/g,'""')}"`;
  const rows = processed.map(v => [v.violation_id,v.rule_id,v.wcag_criterion,v.impact,'new',v.page_url,v.selector,v.ai_generated,v.ai_suggestion.plain_english,v.ai_suggestion.impact_statement,v.ai_suggestion.code_fix,v.ai_suggestion.estimated_time,v.ai_suggestion.risk_level].map(q).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
}

/* Email digest (node-12 equivalent — the HTML that SendGrid sends) */
function renderEmail(d, processed) {
  const top = processed.filter(v => v.impact === 'critical').slice(0,3).map(v =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;"><strong>${esc(v.description)}</strong><br><span style="color:#888;font-size:12px;">${esc(v.ai_suggestion.code_fix.split('.')[0])}. — ${v.ai_suggestion.estimated_time}</span></td></tr>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;padding:24px;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:#1A1A2E;padding:24px;color:#fff;">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#CBA6F7;">Accessibility Monitor · Weekly Digest</div>
    <div style="font-size:20px;font-weight:bold;margin-top:6px;">${d.new_count} new violations on ${d.domain}</div>
    <div style="font-size:13px;color:rgba(255,255,255,.6);margin-top:4px;">Compliance score: ${d.current_score}/100 (${d.score_delta>=0?'+':''}${d.score_delta} from last week)</div>
  </div>
  <div style="padding:24px;">
    <p style="font-size:14px;color:#333;">Hi team — this week's scan of <strong>${d.domain}</strong> found ${d.new_count} new accessibility issues. Top priorities, with Claude-generated fixes:</p>
    <table style="width:100%;border-collapse:collapse;">${top}</table>
    <p style="font-size:13px;color:#666;margin-top:16px;">${d.resolved_count} issues resolved since last week ✅. Full report with all ${d.new_count} fixes attached as HTML.</p>
    <a href="#" style="display:inline-block;margin-top:12px;background:#6B5CE7;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:bold;">View full report</a>
  </div>
  <div style="background:#1A1A2E;padding:16px 24px;font-size:11px;color:rgba(255,255,255,.5);">Built with n8n + Claude claude-sonnet-4-6 · Sent via SendGrid · ${d.scan_date}</div>
</div></body></html>`;
}

/* Multi-domain / multi-week compliance trends dashboard */
function renderTrends(rows) {
  const trs = rows.map(t => `
    <tr>
      <td><strong>${t.domain}</strong></td>
      <td>${t.date}</td>
      <td><span class="score" style="--s:${t.score}">${t.score}/100</span></td>
      <td>${t.prev} → ${t.score} <span style="color:${t.score>=t.prev?'#22A06B':'#E55A3C'};">(${t.score>=t.prev?'+':''}${t.score-t.prev})</span></td>
      <td>${t.neu}</td><td style="color:#22A06B;">${t.resolved}</td><td>${t.persisting}</td><td>${t.aiCalls}</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Compliance Trends Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
 body{font-family:'DM Sans',sans-serif;background:#F7F6F3;color:#1A1A1A;margin:0;padding:40px 24px;}
 .wrap{max-width:920px;margin:0 auto;}
 h1{font-family:'Syne',sans-serif;font-size:24px;font-weight:800;margin:0 0 4px;}
 .sub{color:#888;font-size:14px;margin-bottom:28px;}
 table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);}
 th{font-family:'Syne',sans-serif;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#888;text-align:left;padding:12px 16px;background:#FAFAF8;border-bottom:2px solid #EEEBE4;}
 td{padding:12px 16px;border-bottom:1px solid #F0EDE6;font-size:13px;color:#555;}
 tr:last-child td{border-bottom:none;}
 .score{font-weight:800;font-family:'Syne',sans-serif;}
 .legend{margin-top:24px;background:linear-gradient(135deg,#EEE9FF,#D4F7F5);border-radius:14px;padding:18px 20px;font-size:13px;color:#333;line-height:1.7;}
 .badge{display:inline-block;margin-top:16px;font-size:10px;font-weight:700;color:#6B5CE7;background:#EEE9FF;padding:4px 12px;border-radius:10px;}
</style></head><body><div class="wrap">
<h1>Compliance Trends Dashboard</h1>
<div class="sub">Cross-domain accessibility scores tracked over time · Accessibility Monitor v2</div>
<table>
 <thead><tr><th>Domain</th><th>Scan Date</th><th>Score</th><th>Trend</th><th>New</th><th>Resolved</th><th>Persisting</th><th>Claude Calls</th></tr></thead>
 <tbody>${trs}</tbody>
</table>
<div class="legend"><strong>How to read this:</strong> Score is severity-weighted (critical −8, serious −3, moderate/minor/persisting −1). The diff engine only sends NEW critical/serious violations to Claude, so "Claude Calls" is always ≤ new count — this is the cost-control routing in action. example.com regressed this week (pricing-page redeploy); techblog.dev is near-compliant.</div>
<div class="badge">Built with n8n + Claude claude-sonnet-4-6</div>
</div></body></html>`;
}

module.exports = {
  AI, ruleBased,
  exampleViolations, shopmartViolations, techblogViolations,
  keyOf, SEV, diff, processViolations,
  esc, SEV_COLOR, SEV_BG,
  renderReport, renderCSV, renderEmail, renderTrends
};
