#!/usr/bin/env node
/**
 * frontend_server.js — interactive UI for Accessibility Monitor v2
 *
 * A zero-dependency Node HTTP server (built-in `http` only) that lets you type
 * in your own violations and instantly see what the pipeline produces.
 *
 * It runs the SAME code path as the assignment: it `require`s pipeline.js and
 * calls the real diff -> filter -> merge -> render functions (workflow nodes
 * 6 -> 7 -> 9 -> 10). No logic is re-implemented here, so nothing can drift
 * from generate_outputs.js / scale_test_50.js.
 *
 * Run:  node frontend_server.js     then open  http://localhost:4173
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const {
  exampleViolations, shopmartViolations, techblogViolations,
  diff, processViolations, ruleBased, SEV,
  renderReport, renderCSV, renderEmail, renderTrends, AI
} = require('../pipeline');
const https = require('https');

let scanUrl;
try { ({ scanUrl } = require('./scanner')); }
catch (e) { console.warn('  (scanner.js unavailable — live URL scanning disabled:', e.message, ')'); }

let store;
try { store = require('./db'); }
catch (e) { console.warn('  (db.js unavailable — persistence disabled:', e.message, ')'); }

const { localFix } = require('./livefix');
const { renderAnalytics } = require('./analytics');

let fixHtmlString;
try { ({ fixHtmlString } = require('./autofix')); }
catch (e) { console.warn('  (autofix.js unavailable — /fix disabled:', e.message, ')'); }

const PORT = process.env.PORT || 4173;
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* Preset datasets, exactly as generate_outputs.js uses them (same prevKeys). */
const PRESETS = {
  'example.com': {
    scanId: 'scan_20260523_020000', date: '2026-05-23', prevScore: 70,
    gen: exampleViolations,
    prevKeys: [
      'link-name|.team-card:nth-child(2) a|https://example.com/about',
      'aria-required-attr|.dashboard-widget|https://example.com/app',
      'duplicate-id|#main|https://example.com/'
    ]
  },
  'shopmart.io': {
    scanId: 'scan_20260530_020000', date: '2026-05-30', prevScore: 74,
    gen: shopmartViolations,
    prevKeys: [
      'color-contrast|.add-to-cart|https://shopmart.io/product/123',
      'tabindex|.modal|https://shopmart.io/cart'
    ]
  },
  'techblog.dev': {
    scanId: 'scan_20260530_020500', date: '2026-05-30', prevScore: 88,
    gen: techblogViolations,
    prevKeys: ['html-lang-valid|html|https://techblog.dev/']
  }
};

function presetPayload(name) {
  const p = PRESETS[name];
  const rows = p.gen(name, p.scanId, p.date);
  const prevSet = new Set(p.prevKeys);
  return {
    domain: name, scanId: p.scanId, scanDate: p.date, previousScore: p.prevScore,
    resolvedKeys: p.prevKeys.filter(k => !rows.some(v => `${v.rule_id}|${v.selector}|${v.page_url}` === k)),
    violations: rows.map(v => ({
      rule_id: v.rule_id, wcag_criterion: v.wcag_criterion, impact: v.impact,
      selector: v.selector, page_url: v.page_url, description: v.description,
      html_snippet: v.html_snippet,
      inLastScan: prevSet.has(`${v.rule_id}|${v.selector}|${v.page_url}`)
    }))
  };
}

/* Run the real pipeline on the user's input and return every artifact. */
function runPipeline(input) {
  const domain = (input.domain || 'mysite.com').trim();
  const scanId = (input.scanId || 'scan_live').trim();
  const scanDate = (input.scanDate || new Date().toISOString().slice(0, 10)).trim();

  const current = (input.violations || []).map((v, i) => ({
    rule_id: v.rule_id || 'unknown-rule',
    wcag_criterion: v.wcag_criterion || '—',
    impact: ['critical', 'serious', 'moderate', 'minor'].includes(v.impact) ? v.impact : 'moderate',
    selector: v.selector || '—',
    html_snippet: v.html_snippet || '',
    description: v.description || `Violation of rule ${v.rule_id || 'unknown-rule'}`,
    page_url: v.page_url || `https://${domain}/`,
    violation_id: `${scanId}_${v.rule_id || 'rule'}_${i}`,
    scan_id: scanId,
    collected_at: scanDate
  }));

  if (current.length === 0) {
    throw new Error('Add at least one violation before running the pipeline.');
  }

  // previousKeys = current rows flagged "in last scan" + any standalone resolved keys
  const previousKeys = new Set([
    ...current
      .filter((_, i) => input.violations[i] && input.violations[i].inLastScan)
      .map(v => `${v.rule_id}|${v.selector}|${v.page_url}`),
    ...((input.resolvedKeys || []).map(s => s.trim()).filter(Boolean))
  ]);
  const previousScore = Number.isFinite(+input.previousScore) ? +input.previousScore : 70;
  return buildArtifacts(current, previousKeys, previousScore);
}

/* Fix suggestions for a LIVE scan. With ANTHROPIC_API_KEY set, calls the real
 * claude-sonnet-4-6 Messages API (only for critical/serious — the node-7 filter);
 * otherwise uses the honest rule-based fallback. Never reuses the captured
 * scenario text, which is specific to the assignment's demo sites. */
async function processViolationsLive(newV) {
  const useKey = !!process.env.ANTHROPIC_API_KEY;
  const out = [];
  for (const v of newV) {
    const eligible = ['critical', 'serious'].includes(v.impact);
    if (eligible && useKey) {
      try {
        out.push({ ...v, ai_suggestion: await callClaude(v), ai_generated: true });
        continue;
      } catch (e) {
        console.warn('  Claude call failed, falling back to rule-based:', e.message);
      }
    }
    // Concrete, rule-specific guidance (uses axe's failure summary + per-rule KB),
    // not the generic "refer to the documentation" fallback.
    out.push({ ...v, ai_suggestion: localFix(v), ai_generated: false });
  }
  return out;
}

/* Real claude-sonnet-4-6 call via built-in https (no SDK dependency). */
function callClaude(v) {
  const prompt = `You are an accessibility expert. An axe-core scan found this WCAG violation:
rule: ${v.rule_id} (WCAG ${v.wcag_criterion}, impact: ${v.impact})
page: ${v.page_url}
selector: ${v.selector}
html: ${v.html_snippet}
description: ${v.description}

Respond with ONLY a JSON object (no markdown) with these keys:
plain_english (what's wrong, 1-2 sentences), impact_statement (who it affects),
code_fix (concrete fix with before/after), estimated_time, risk_level (Low/Medium/High).`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) return reject(new Error(`API ${res.statusCode}: ${raw.slice(0,200)}`));
          const text = JSON.parse(raw).content.map(b => b.text || '').join('');
          const json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
          resolve({
            plain_english: json.plain_english || '', impact_statement: json.impact_statement || '',
            code_fix: json.code_fix || '', estimated_time: json.estimated_time || '—',
            risk_level: json.risk_level || 'Low'
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Claude API timeout')));
    req.write(body); req.end();
  });
}

/* Run a live scan + time-series diff + render the artifact bundle. Shared by the
 * /scan route and the scheduled monitor. Attaches `prior` for regression checks. */
async function runLiveScan(url, maxPagesRaw) {
  if (!scanUrl) throw new Error('Live scanning unavailable (scanner.js failed to load). Run: npm install');
  const maxPages = Math.max(1, Math.min(20, parseInt(maxPagesRaw, 10) || 1));
  const scan = await scanUrl(url, { timeoutMs: 45000, maxPages });
  const prior = store ? store.previousFor(scan.domain) : null;
  const history = store ? store.domainHistory(scan.domain) : [];
  const out = await buildArtifacts(scan.violations, new Set(prior ? prior.keys : []), prior ? prior.score : null, {
    live: true, absolute: true, pageUrl: scan.pageUrl, engine: scan.tested,
    comparedTo: prior ? (prior.scan_date || prior.created_at) : null,
    scanNumber: history.length + 1,
    pagesScanned: scan.pagesScanned.length, evidence: scan.evidence, warning: scan.warning,
    meta: { domain: scan.domain, scan_id: scan.scanId, scan_date: scan.scanDate }
  });
  out.scan = { url: scan.pageUrl, domain: scan.domain, engine: scan.tested,
    total_nodes: scan.violations.length, pages: scan.pagesScanned };
  out.prior = prior;
  return out;
}

/* Shared render core — used by manual /run AND live /scan. */
async function buildArtifacts(current, previousKeys, previousScore, opts = {}) {
  let d;
  if (current.length === 0) {
    // A perfectly clean page (0 violations) — the ideal outcome. diff() assumes
    // at least one row, so synthesize a perfect-score result instead of crashing.
    const m = opts.meta || {};
    const prev = (previousScore == null) ? 100 : previousScore;
    d = {
      domain: m.domain, scan_id: m.scan_id, scan_date: m.scan_date,
      new: [], persisting: [], resolved: [...(previousKeys || [])],
      new_count: 0, persisting_count: 0, resolved_count: previousKeys ? previousKeys.size : 0,
      current_score: 100, previous_score: prev, score_delta: 100 - prev
    };
  } else {
    d = diff(current, previousKeys, previousScore == null ? 0 : previousScore);
    if (opts.absolute) {
      // Severity-weighted ABSOLUTE score, comparable run-to-run (a re-scan of the
      // same broken page yields the same score). new/persisting/resolved still come
      // from the real diff vs the previous stored scan — true time-series tracking.
      const absScore = Math.max(0, 100 - current.reduce((s, v) => s + (SEV[v.impact] || 1), 0));
      d.current_score = absScore;
      d.previous_score = (previousScore == null) ? absScore : previousScore;
      d.score_delta = absScore - d.previous_score;
    } else if (opts.baseline) {
      d.previous_score = d.current_score; d.score_delta = 0;
    }
  }

  // Manual/preset runs replay the captured claude-sonnet-4-6 responses (assignment
  // behavior). Live scans of arbitrary sites must NOT reuse that scenario-specific
  // text — call the real Claude API when a key is present, else honest rule-based.
  let processed;
  if (opts.live) {
    processed = await processViolationsLive(d.new);
  } else {
    processed = processViolations(d.new);
  }
  const aiCalls = processed.filter(v => v.ai_generated).length;

  return {
    summary: {
      domain: d.domain, scan_id: d.scan_id, scan_date: d.scan_date,
      current_score: d.current_score, previous_score: d.previous_score, score_delta: d.score_delta,
      new_count: d.new_count, persisting_count: d.persisting_count, resolved_count: d.resolved_count,
      total_current: current.length, claude_calls: aiCalls,
      saved_calls: d.new_count - aiCalls,
      live: !!opts.live, page_url: opts.pageUrl || null, engine: opts.engine || null,
      compared_to: opts.comparedTo || null, scan_number: opts.scanNumber || 1,
      pages_scanned: opts.pagesScanned || 1, warning: opts.warning || null
    },
    evidence: opts.evidence || [],
    // Structured NEW violations so the UI can render them natively (matches renderReport).
    violations: processed.map(v => ({
      impact: v.impact, description: v.description, rule_id: v.rule_id,
      wcag_criterion: v.wcag_criterion, page_url: v.page_url, selector: v.selector,
      ai_generated: !!v.ai_generated,
      plain_english: v.ai_suggestion.plain_english,
      impact_statement: v.ai_suggestion.impact_statement,
      code_fix: v.ai_suggestion.code_fix,
      estimated_time: v.ai_suggestion.estimated_time,
      risk_level: v.ai_suggestion.risk_level
    })),
    report: renderReport(d, processed),
    email: renderEmail(d, processed),
    csv: renderCSV(d, processed),
    trends: renderTrends([{
      domain: d.domain, date: d.scan_date, score: d.current_score, prev: d.previous_score,
      neu: d.new_count, resolved: d.resolved_count, persisting: d.persisting_count, aiCalls
    }]),
    diff: {
      ...d,
      new: d.new.map(v => ({ rule_id: v.rule_id, impact: v.impact, selector: v.selector, page_url: v.page_url, wcag_criterion: v.wcag_criterion, stable_key: v.stable_key })),
      // page_url is part of the stable key — must be kept so re-scans match correctly
      persisting: d.persisting.map(v => ({ rule_id: v.rule_id, impact: v.impact, selector: v.selector, page_url: v.page_url, wcag_criterion: v.wcag_criterion, stable_key: v.stable_key }))
    }
  };
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', HTML);
  }
  if (req.method === 'GET' && req.url === '/rules') {
    // Expose which rule_ids have a captured Claude suggestion (vs rule-based fallback)
    return send(res, 200, 'application/json', JSON.stringify(Object.keys(AI)));
  }
  if (req.method === 'GET' && req.url.startsWith('/preset/')) {
    const name = decodeURIComponent(req.url.slice('/preset/'.length));
    if (!PRESETS[name]) return send(res, 404, 'application/json', JSON.stringify({ error: 'unknown preset' }));
    return send(res, 200, 'application/json', JSON.stringify(presetPayload(name)));
  }
  if (req.method === 'POST' && req.url === '/run') {
    return readBody(req, res, async body => {
      const out = await runPipeline(body);
      persist(out);
      send(res, 200, 'application/json', JSON.stringify(out));
    });
  }
  if (req.method === 'POST' && req.url === '/scan') {
    return readBody(req, res, async body => {
      const out = await runLiveScan(body.url, body.maxPages);
      persist(out);
      send(res, 200, 'application/json', JSON.stringify(out));
    });
  }
  if (req.method === 'POST' && req.url === '/send') {
    return readBody(req, res, async body => {
      const result = await sendEmail(body);
      send(res, 200, 'application/json', result);
    });
  }
  if (req.method === 'POST' && req.url === '/fix') {
    return readBody(req, res, async body => {
      if (!fixHtmlString) throw new Error('Auto-fix unavailable (autofix.js failed to load).');
      if (!body.html || !body.html.trim()) throw new Error('Paste some HTML to fix.');
      const out = await fixHtmlString(body.html);
      out.aiAvailable = !!process.env.ANTHROPIC_API_KEY;
      send(res, 200, 'application/json', JSON.stringify(out));
    });
  }

  /* ---- Persistence / history API (the back-end data layer) ---- */
  if (req.method === 'GET' && req.url === '/api/scans') {
    if (!store) return send(res, 200, 'application/json', '[]');
    return send(res, 200, 'application/json', JSON.stringify(store.listScans(200)));
  }
  if (req.method === 'GET' && /^\/api\/scans\/\d+$/.test(req.url)) {
    if (!store) return send(res, 404, 'application/json', JSON.stringify({ error: 'persistence disabled' }));
    const row = store.getScan(+req.url.split('/').pop());
    if (!row) return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
    // Re-shape a stored row back into the artifact bundle the frontend renders.
    return send(res, 200, 'application/json', JSON.stringify({
      summary: {
        domain: row.domain, scan_id: row.scan_id, scan_date: row.scan_date,
        current_score: row.current_score, previous_score: row.previous_score, score_delta: row.score_delta,
        new_count: row.new_count, persisting_count: row.persisting_count, resolved_count: row.resolved_count,
        claude_calls: row.claude_calls, saved_calls: Math.max(0, row.new_count - row.claude_calls),
        live: row.source === 'live', page_url: row.page_url, engine: row.engine,
        pages_scanned: row.pages_scanned || 1, scan_number: null, compared_to: null
      },
      report: row.report_html, email: row.email_html, csv: row.csv_text,
      trends: row.trends_html, diff: JSON.parse(row.diff_json || '{}'),
      evidence: row.evidence || [],
      violations: JSON.parse(row.violations_json || '[]'),
      saved: { id: row.id, created_at: row.created_at }
    }));
  }
  if (req.method === 'DELETE' && /^\/api\/scans\/\d+$/.test(req.url)) {
    if (!store) return send(res, 404, 'application/json', JSON.stringify({ error: 'persistence disabled' }));
    const ok = store.deleteScan(+req.url.split('/').pop());
    return send(res, ok ? 200 : 404, 'application/json', JSON.stringify({ ok }));
  }
  if (req.method === 'GET' && req.url === '/api/trends') {
    // Real cross-scan dashboard built from the DB (latest scan per domain).
    const rows = (store && store.count()) ? store.trendRows() : [];
    return send(res, 200, 'text/html; charset=utf-8', renderTrends(rows));
  }
  if (req.method === 'GET' && req.url === '/api/analytics') {
    // Aggregated analytics dashboard (charts) built from the whole database.
    const data = store ? store.analytics() : { totals: {}, topRules: [], impact: [], series: {} };
    return send(res, 200, 'text/html; charset=utf-8', renderAnalytics(data));
  }

  /* ---- Scheduled monitoring (watch list) ---- */
  if (req.method === 'GET' && req.url === '/api/watches') {
    return send(res, 200, 'application/json', JSON.stringify(store ? store.listWatches() : []));
  }
  if (req.method === 'POST' && req.url === '/api/watches') {
    return readBody(req, res, async body => {
      if (!store) throw new Error('persistence disabled');
      if (!body.url) throw new Error('A URL is required to watch.');
      const id = store.addWatch({ url: body.url, maxPages: body.maxPages, email: body.email, intervalMin: body.intervalMin });
      send(res, 200, 'application/json', JSON.stringify({ id }));
    });
  }
  if (req.method === 'DELETE' && /^\/api\/watches\/\d+$/.test(req.url)) {
    if (!store) return send(res, 404, 'application/json', JSON.stringify({ error: 'persistence disabled' }));
    const ok = store.deleteWatch(+req.url.split('/').pop());
    return send(res, ok ? 200 : 404, 'application/json', JSON.stringify({ ok }));
  }

  send(res, 404, 'text/plain', 'Not found');
});

function readBody(req, res, handler) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(); });
  req.on('end', async () => {
    try { await handler(JSON.parse(raw || '{}')); }
    catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
  });
}

/* Save a built bundle to the DB; never let a storage hiccup break the response. */
function persist(out) {
  if (!store) return;
  try { out.saved = { id: store.saveScan(out) }; }
  catch (e) { console.warn('  persist failed:', e.message); }
}

/* ----------------------------------------------------------------------------
 * Scheduled monitoring: re-scan watched URLs on their interval and email an
 * alert ONLY when accessibility regresses (score drops or new critical/serious).
 * -------------------------------------------------------------------------- */
function regressionOf(out) {
  if (!out.prior) return null;                       // first scan = baseline, never alert
  const newSevere = (out.diff.new || []).filter(v => ['critical', 'serious'].includes(v.impact)).length;
  if (out.summary.score_delta < 0 || newSevere > 0) return { newSevere, delta: out.summary.score_delta };
  return null;
}

function sendRegressionEmail(to, out, reg) {
  const s = out.summary;
  const bodyText =
`Accessibility REGRESSION detected on ${s.domain}

Score: ${s.current_score}/100 (${reg.delta >= 0 ? '+' : ''}${reg.delta} vs your previous scan)
New issues: ${s.new_count}  (${reg.newSevere} critical/serious)
Resolved: ${s.resolved_count} · Persisting: ${s.persisting_count}
Scanned: ${s.page_url || s.domain}

The full HTML audit report is attached. This is an automated alert from your scheduled monitor.

— Accessibility Monitor`;
  return sendEmail({
    to, subject: `⚠ A11y regression: ${s.domain} → ${s.current_score}/100 (${reg.delta} pts)`,
    bodyText, html: out.report, domain: s.domain, scanDate: s.scan_date
  });
}

let monitorBusy = false;
function startMonitor() {
  if (!store || !scanUrl) { console.log('  Monitor:   off (needs DB + scanner)'); return; }
  const tick = async () => {
    if (monitorBusy) return;
    let due = [];
    try { due = store.dueWatches(); } catch { return; }
    if (!due.length) return;
    monitorBusy = true;
    for (const w of due) {
      try {
        const out = await runLiveScan(w.url, w.max_pages);
        persist(out);
        const reg = regressionOf(out);
        let status = !out.prior ? 'baseline' : (reg ? `regressed (${reg.delta} pts, ${reg.newSevere} new critical/serious)` : 'stable');
        if (reg && w.email) {
          await sendRegressionEmail(w.email, out, reg).then(() => status += ' · alert sent').catch(e => { status += ' · alert failed'; console.warn('  [monitor] alert email failed:', e.message); });
        }
        store.markRun(w.id, status);
        console.log(`  [monitor] ${out.summary.domain}: ${status}`);
      } catch (e) {
        try { store.markRun(w.id, 'error: ' + e.message.slice(0, 80)); } catch {}
        console.warn(`  [monitor] ${w.url} failed: ${e.message}`);
      }
    }
    monitorBusy = false;
  };
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 5000); // first pass shortly after boot
  console.log('  Monitor:   ON — checks watches every 60s, alerts on regression');
}

/* ----------------------------------------------------------------------------
 * Email delivery via the macOS Mail app (no API key / SMTP password needed —
 * uses whatever account Mail is already signed into). The full HTML report is
 * attached; the digest summary becomes the message body.
 * -------------------------------------------------------------------------- */
const APPLESCRIPT = `on run argv
  set theTo to item 1 of argv
  set theSubject to item 2 of argv
  set theBody to (read (POSIX file (item 3 of argv)) as «class utf8»)
  set attachPath to item 4 of argv
  tell application "Mail"
    set msg to make new outgoing message with properties {subject:theSubject, content:theBody, visible:true}
    tell msg
      make new to recipient at end of to recipients with properties {address:theTo}
      try
        make new attachment with properties {file name:(POSIX file attachPath)} at after the last paragraph
      end try
    end tell
    send msg
  end tell
  return "sent"
end run`;

function sendEmail({ to, subject, bodyText, html, domain, scanDate }) {
  return new Promise((resolve, reject) => {
    const addr = (to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return reject(new Error('Enter a valid recipient email address.'));
    if (process.platform !== 'darwin') return reject(new Error('Mail.app sending is only available on macOS.'));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-mail-'));
    const bodyFile = path.join(tmp, 'body.txt');
    const attachFile = path.join(tmp, `accessibility_report_${(domain || 'site')}_${(scanDate || 'scan')}.html`);
    const scriptFile = path.join(tmp, 'send.applescript');
    fs.writeFileSync(bodyFile, bodyText || 'Accessibility report attached.');
    fs.writeFileSync(attachFile, html || '<p>No report.</p>');
    fs.writeFileSync(scriptFile, APPLESCRIPT);

    execFile('osascript', [scriptFile, addr, subject || 'Accessibility report', bodyFile, attachFile],
      { timeout: 30000 }, (err, stdout, stderr) => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        if (err) {
          const msg = (stderr || err.message || '').trim();
          if (/-1728|isn.t running|Application isn/.test(msg) || /Mail got an error/.test(msg)) {
            return reject(new Error('Could not reach Mail.app. Open the Mail app and make sure an email account is signed in, then try again.'));
          }
          return reject(new Error('Mail send failed: ' + msg));
        }
        resolve({ ok: true, to: addr, via: 'macOS Mail.app' });
      });
  });
}

server.listen(PORT, () => {
  console.log(`\n  Accessibility Monitor v2 — interactive frontend`);
  console.log(`  Live scan: ${scanUrl ? 'ON (real axe-core via system Chrome)' : 'OFF (npm install needed)'}`);
  console.log(`  Database:  ${store ? `SQLite (data/monitor.db) — ${store.count()} scans stored` : 'OFF (npm install needed)'}`);
  console.log(`  Email:     macOS Mail.app handoff`);
  startMonitor();
  console.log(`\n  ▸ Open  http://localhost:${PORT}\n`);
});
