/**
 * Automated tests for Accessibility Monitor v2 — run with: npm test
 * Uses Node's built-in test runner (node:test) + assert. No extra dependencies.
 *
 * Covers the pure logic that the whole app depends on: the diff/score engine,
 * the live fix knowledge base, the scanner's mapping helpers, and a full DB
 * round-trip (against a throwaway database via MONITOR_DB).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a throwaway DB for the DB tests — must be set before requiring ./db.
process.env.MONITOR_DB = path.join(os.tmpdir(), `monitor-test-${Date.now()}.db`);

const pipeline = require('../pipeline');
const { localFix } = require('../src/livefix');
const { normalizeUrl, wcagFromTags } = require('../src/scanner');
const { renderAnalytics } = require('../src/analytics');

/* ----------------------------- pipeline: diff ----------------------------- */
test('diff classifies new / persisting / resolved correctly', () => {
  const v = (rule, sel, impact) => ({
    rule_id: rule, selector: sel, impact, wcag_criterion: '1.1.1',
    page_url: 'https://x.com/', scan_id: 's', collected_at: '2026-01-01'
  });
  const current = [v('image-alt', '.a', 'critical'), v('label', '.b', 'critical')];
  // previous had .a (persists) and .c (now resolved)
  const prev = new Set(['image-alt|.a|https://x.com/', 'link-name|.c|https://x.com/']);
  const d = pipeline.diff(current, prev, 80);
  assert.equal(d.new_count, 1, 'one new (.b)');
  assert.equal(d.persisting_count, 1, 'one persisting (.a)');
  assert.equal(d.resolved_count, 1, 'one resolved (.c)');
  assert.equal(d.new[0].selector, '.b');
});

test('score is severity-weighted and never negative', () => {
  const v = (impact) => ({ rule_id: 'r' + Math.random(), selector: '.s' + Math.random(), impact, page_url: 'https://x.com/', scan_id: 's', collected_at: 'd' });
  // 1 critical (-8) from a previous-empty set => all new => 100 - 8 = 92
  const d = pipeline.diff([v('critical')], new Set(), 100);
  assert.equal(d.current_score, 92);
  // many criticals clamp at 0
  const many = Array.from({ length: 20 }, () => v('critical'));
  assert.equal(pipeline.diff(many, new Set(), 100).current_score, 0);
});

test('keyOf is rule|selector|page_url', () => {
  assert.equal(pipeline.keyOf({ rule_id: 'image-alt', selector: '.x', page_url: 'https://y/' }), 'image-alt|.x|https://y/');
});

test('processViolations sends critical/serious with a captured fix to AI, others rule-based', () => {
  const out = pipeline.processViolations([
    { rule_id: 'image-alt', impact: 'critical', selector: '.a', page_url: 'p', wcag_criterion: '1.1.1' },
    { rule_id: 'heading-order', impact: 'minor', selector: '.b', page_url: 'p', wcag_criterion: '1.3.1' }
  ]);
  assert.equal(out[0].ai_generated, true, 'image-alt critical => AI');
  assert.equal(out[1].ai_generated, false, 'minor => rule-based');
});

/* ------------------------------- livefix ---------------------------------- */
test('localFix gives a concrete color-contrast fix using captured ratio', () => {
  const fix = localFix({ rule_id: 'color-contrast', impact: 'serious', selector: '.t', page_url: 'p',
    fix_data: { contrastRatio: 2.1, fgColor: '#999999', bgColor: '#ffffff', expectedContrastRatio: '4.5:1' } });
  assert.match(fix.code_fix, /4\.5:1/);
  assert.match(fix.plain_english, /2\.1/);
  assert.doesNotMatch(fix.code_fix, /refer to .* documentation/i);
});

test('localFix falls back to axe failure summary for unknown rules', () => {
  const fix = localFix({ rule_id: 'some-novel-rule', impact: 'moderate', selector: '.z', page_url: 'p',
    failure_summary: 'Fix any of the following: element X is broken', help_url: 'https://help/' });
  assert.match(fix.code_fix, /element X is broken/);
  assert.match(fix.code_fix, /https:\/\/help\//);
});

/* ------------------------------- scanner ---------------------------------- */
test('wcagFromTags converts axe tags to a criterion', () => {
  assert.equal(wcagFromTags(['cat.color', 'wcag2aa', 'wcag143']), '1.4.3');
  assert.equal(wcagFromTags(['best-practice']), '—');
});

test('normalizeUrl adds scheme and validates', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('http://x.io/a'), 'http://x.io/a');
  assert.throws(() => normalizeUrl(''), /Enter a website URL/);
});

/* ------------------------------- analytics -------------------------------- */
test('renderAnalytics returns an HTML document', () => {
  const html = renderAnalytics({ totals: { scans: 2, domains: 1, violations: 5 }, topRules: [{ rule_id: 'image-alt', n: 3 }], impact: [{ impact: 'critical', n: 3 }], series: { 'x.com': [{ score: 80 }, { score: 90 }] } });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /image-alt/);
});

/* --------------------------- db round-trip -------------------------------- */
test('db: save → list → get → previousFor → delete', () => {
  const db = require('../src/db');
  const bundle = {
    summary: { domain: 'demo.test', scan_id: 's1', scan_date: '2026-01-01', current_score: 76,
      previous_score: 76, score_delta: 0, new_count: 1, persisting_count: 0, resolved_count: 0,
      claude_calls: 0, engine: 'axe-core 4.12', live: true, page_url: 'https://demo.test/', pages_scanned: 1 },
    report: '<html>r</html>', email: '<html>e</html>', csv: 'a,b\n1,2\n', trends: '<html>t</html>',
    diff: { new: [{ rule_id: 'image-alt', impact: 'critical', selector: '.a', page_url: 'https://demo.test/', wcag_criterion: '1.1.1' }], persisting: [] },
    evidence: [{ rule_id: 'image-alt', impact: 'critical', selector: '.a', page_url: 'https://demo.test/', screenshot: 'data:image/png;base64,AAA' }]
  };
  const id = db.saveScan(bundle);
  assert.ok(id > 0);

  const list = db.listScans(10);
  assert.equal(list[0].domain, 'demo.test');

  const got = db.getScan(id);
  assert.equal(got.report_html, '<html>r</html>');
  assert.equal(got.violations.length, 1);
  assert.equal(got.evidence.length, 1);

  // previousFor rebuilds the stable key from stored rows (the bug we fixed lives here)
  const prior = db.previousFor('demo.test');
  assert.deepEqual(prior.keys, ['image-alt|.a|https://demo.test/']);

  assert.equal(db.deleteScan(id), true);
});

test('db: watch list add / list / delete', () => {
  const db = require('../src/db');
  const id = db.addWatch({ url: 'https://w.test', email: 'a@b.c', intervalMin: 15, maxPages: 1 });
  assert.ok(db.listWatches().some(w => w.id === id));
  assert.equal(db.deleteWatch(id), true);
});

// Clean up the throwaway DB files after the run.
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.MONITOR_DB + suffix); } catch {}
  }
});
