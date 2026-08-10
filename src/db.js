/**
 * db.js — persistence layer for Accessibility Monitor v2 (the "back end").
 *
 * A real SQLite database (better-sqlite3) that stores every scan/run, its
 * rendered artifacts, and the individual violations — turning the previously
 * stateless tool into a full-stack app with history, re-display, and
 * cross-scan trends queried from stored data.
 *
 * The DB file lives at  data/monitor.db  (created on first run).
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// DB path is overridable (MONITOR_DB) so tests can use a throwaway/in-memory DB.
const DB_PATH = process.env.MONITOR_DB || path.join(__dirname, '..', 'data', 'monitor.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id         TEXT,
    domain          TEXT,
    page_url        TEXT,
    source          TEXT,            -- 'live' | 'manual'
    scan_date       TEXT,
    current_score   INTEGER,
    previous_score  INTEGER,
    score_delta     INTEGER,
    new_count       INTEGER,
    persisting_count INTEGER,
    resolved_count  INTEGER,
    claude_calls    INTEGER,
    engine          TEXT,
    report_html     TEXT,
    email_html      TEXT,
    csv_text        TEXT,
    trends_html     TEXT,
    diff_json       TEXT,
    pages_scanned   INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS evidence (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_pk   INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    rule_id   TEXT,
    impact    TEXT,
    selector  TEXT,
    page_url  TEXT,
    img       TEXT      -- base64 data URL of the highlighted element
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_scan ON evidence(scan_pk);

  CREATE TABLE IF NOT EXISTS violations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_pk     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    rule_id     TEXT,
    wcag        TEXT,
    impact      TEXT,
    selector    TEXT,
    page_url    TEXT,
    status      TEXT,                -- 'new' | 'persisting'
    ai_generated INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_violations_scan ON violations(scan_pk);
  CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at);

  CREATE TABLE IF NOT EXISTS watches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL,
    max_pages    INTEGER DEFAULT 1,
    email        TEXT,
    interval_min INTEGER DEFAULT 60,
    active       INTEGER DEFAULT 1,
    last_run     TEXT,
    last_status  TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
`);

/* Idempotent migrations for DBs created before a column existed. */
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('scans', 'pages_scanned', 'pages_scanned INTEGER DEFAULT 1');
// Rich per-violation data (descriptions + AI fixes) so saved scans can be
// re-rendered natively in the UI, not just as the pre-baked report HTML.
ensureColumn('scans', 'violations_json', 'violations_json TEXT');

const insertScan = db.prepare(`
  INSERT INTO scans (scan_id, domain, page_url, source, scan_date, current_score,
    previous_score, score_delta, new_count, persisting_count, resolved_count,
    claude_calls, engine, report_html, email_html, csv_text, trends_html, diff_json, pages_scanned, violations_json)
  VALUES (@scan_id, @domain, @page_url, @source, @scan_date, @current_score,
    @previous_score, @score_delta, @new_count, @persisting_count, @resolved_count,
    @claude_calls, @engine, @report_html, @email_html, @csv_text, @trends_html, @diff_json, @pages_scanned, @violations_json)
`);

const insertViolation = db.prepare(`
  INSERT INTO violations (scan_pk, rule_id, wcag, impact, selector, page_url, status, ai_generated)
  VALUES (@scan_pk, @rule_id, @wcag, @impact, @selector, @page_url, @status, @ai_generated)
`);

const insertEvidence = db.prepare(`
  INSERT INTO evidence (scan_pk, rule_id, impact, selector, page_url, img)
  VALUES (@scan_pk, @rule_id, @impact, @selector, @page_url, @img)
`);

/* Persist a built artifact bundle. `out` is what buildArtifacts() returns. */
const saveScan = db.transaction((out) => {
  const s = out.summary;
  const info = insertScan.run({
    scan_id: s.scan_id, domain: s.domain, page_url: s.page_url || null,
    source: s.live ? 'live' : 'manual', scan_date: s.scan_date,
    current_score: s.current_score, previous_score: s.previous_score, score_delta: s.score_delta,
    new_count: s.new_count, persisting_count: s.persisting_count, resolved_count: s.resolved_count,
    claude_calls: s.claude_calls, engine: s.engine || null,
    report_html: out.report, email_html: out.email, csv_text: out.csv,
    trends_html: out.trends, diff_json: JSON.stringify(out.diff),
    pages_scanned: (s.pages_scanned || 1),
    violations_json: JSON.stringify(out.violations || [])
  });
  const pk = info.lastInsertRowid;
  const rows = [
    ...(out.diff.new || []).map(v => ({ ...v, status: 'new' })),
    ...(out.diff.persisting || []).map(v => ({ ...v, status: 'persisting' }))
  ];
  for (const v of rows) {
    insertViolation.run({
      scan_pk: pk, rule_id: v.rule_id, wcag: v.wcag_criterion || null,
      impact: v.impact, selector: v.selector, page_url: v.page_url || null,
      status: v.status, ai_generated: v.ai_generated ? 1 : 0
    });
  }
  for (const e of (out.evidence || [])) {
    insertEvidence.run({
      scan_pk: pk, rule_id: e.rule_id, impact: e.impact,
      selector: e.selector, page_url: e.page_url || null, img: e.screenshot
    });
  }
  return pk;
});

const listStmt = db.prepare(`
  SELECT id, scan_id, domain, page_url, source, scan_date, current_score, score_delta,
         new_count, persisting_count, resolved_count, claude_calls, engine, created_at
  FROM scans ORDER BY id DESC LIMIT @limit
`);
const listScans = (limit = 100) => listStmt.all({ limit });

const getStmt = db.prepare(`SELECT * FROM scans WHERE id = ?`);
const getViolStmt = db.prepare(`SELECT rule_id, wcag, impact, selector, page_url, status, ai_generated FROM violations WHERE scan_pk = ?`);
const getEvidStmt = db.prepare(`SELECT rule_id, impact, selector, page_url, img FROM evidence WHERE scan_pk = ?`);
function getScan(id) {
  const row = getStmt.get(id);
  if (!row) return null;
  row.violations = getViolStmt.all(id);
  row.evidence = getEvidStmt.all(id).map(e => ({ rule_id: e.rule_id, impact: e.impact, selector: e.selector, page_url: e.page_url, screenshot: e.img }));
  return row;
}

const deleteStmt = db.prepare(`DELETE FROM scans WHERE id = ?`);
const deleteScan = (id) => deleteStmt.run(id).changes > 0;

/* Aggregate the latest scan per domain for a real, data-driven trends dashboard. */
const trendRowsStmt = db.prepare(`
  SELECT domain, scan_date AS date, current_score AS score, previous_score AS prev,
         new_count AS neu, resolved_count AS resolved, persisting_count AS persisting,
         claude_calls AS aiCalls
  FROM scans s
  WHERE id = (SELECT MAX(id) FROM scans WHERE domain = s.domain)
  ORDER BY domain
`);
const trendRows = () => trendRowsStmt.all();

const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM scans`);
const count = () => countStmt.get().n;

/* The most recent prior scan of a domain — used to diff a new live scan against
 * history (real new/resolved/persisting + score trend), turning the tool into a
 * genuine time-series monitor. Call BEFORE inserting the new scan. */
const prevScanStmt = db.prepare(`SELECT id, current_score, scan_date, created_at FROM scans WHERE domain = ? ORDER BY id DESC LIMIT 1`);
const prevViolStmt = db.prepare(`SELECT rule_id, selector, page_url FROM violations WHERE scan_pk = ?`);
function previousFor(domain) {
  const s = prevScanStmt.get(domain);
  if (!s) return null;
  const keys = prevViolStmt.all(s.id).map(v => `${v.rule_id}|${v.selector}|${v.page_url}`);
  return { id: s.id, score: s.current_score, scan_date: s.scan_date, created_at: s.created_at, keys };
}

/* Absolute-score history for one domain (oldest→newest) for a trend chart. */
const domainHistoryStmt = db.prepare(`
  SELECT scan_date, created_at, current_score, new_count, resolved_count, persisting_count
  FROM scans WHERE domain = ? ORDER BY id ASC`);
const domainHistory = (domain) => domainHistoryStmt.all(domain);

/* Aggregations for the analytics dashboard. */
const topRulesStmt = db.prepare(`
  SELECT rule_id, COUNT(*) AS n FROM violations GROUP BY rule_id ORDER BY n DESC LIMIT 12`);
const impactStmt = db.prepare(`
  SELECT impact, COUNT(*) AS n FROM violations GROUP BY impact`);
const totalsStmt = db.prepare(`
  SELECT (SELECT COUNT(*) FROM scans) AS scans,
         (SELECT COUNT(DISTINCT domain) FROM scans) AS domains,
         (SELECT COUNT(*) FROM violations) AS violations,
         (SELECT COALESCE(SUM(claude_calls),0) FROM scans) AS claude_calls,
         (SELECT COALESCE(SUM(pages_scanned),0) FROM scans) AS pages`);
const scoreSeriesStmt = db.prepare(`
  SELECT domain, current_score AS score, created_at FROM scans ORDER BY id ASC`);
function analytics() {
  const series = {};
  for (const r of scoreSeriesStmt.all()) (series[r.domain] = series[r.domain] || []).push({ score: r.score, at: r.created_at });
  return {
    totals: totalsStmt.get(),
    topRules: topRulesStmt.all(),
    impact: impactStmt.all(),
    series
  };
}

/* ---- Watch list (scheduled monitoring) ---- */
const addWatchStmt = db.prepare(`INSERT INTO watches (url, max_pages, email, interval_min) VALUES (@url, @max_pages, @email, @interval_min)`);
const addWatch = (w) => addWatchStmt.run({ url: w.url, max_pages: w.maxPages || 1, email: w.email || null, interval_min: w.intervalMin || 60 }).lastInsertRowid;
const listWatchesStmt = db.prepare(`SELECT * FROM watches ORDER BY id DESC`);
const listWatches = () => listWatchesStmt.all();
const deleteWatchStmt = db.prepare(`DELETE FROM watches WHERE id = ?`);
const deleteWatch = (id) => deleteWatchStmt.run(id).changes > 0;
// Watches whose interval has elapsed (or never run).
const dueWatchesStmt = db.prepare(`
  SELECT * FROM watches WHERE active = 1
  AND (last_run IS NULL OR (julianday('now') - julianday(last_run)) * 1440.0 >= interval_min)`);
const dueWatches = () => dueWatchesStmt.all();
const markRunStmt = db.prepare(`UPDATE watches SET last_run = datetime('now'), last_status = ? WHERE id = ?`);
const markRun = (id, status) => markRunStmt.run(status, id);

module.exports = {
  saveScan, listScans, getScan, deleteScan, trendRows, count, previousFor, domainHistory, analytics,
  addWatch, listWatches, deleteWatch, dueWatches, markRun
};
