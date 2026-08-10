# Accessibility Monitor v2

A full-stack web-accessibility monitoring tool. Paste a URL → it launches a real
headless Chrome, runs **axe-core** against the live page(s) across the full
**WCAG 2.0 / 2.1 / 2.2 A & AA** ruleset, and produces an audit report, an email
digest, a CSV, and screenshot evidence — then tracks how the site changes over
time and can email you when accessibility **regresses**.

Built on top of Assignment 4's n8n workflow logic ([pipeline.js](pipeline.js) —
the diff → filter → merge → render engine), extended into a real application.

---

## Quick start

```bash
npm install         # installs puppeteer-core, axe-core, better-sqlite3
npm start           # starts the server
# open http://localhost:4173
```

Requirements: **Node 18+** (developed on 22.11) and **Google Chrome** installed
(the scanner drives your system Chrome — set `CHROME_PATH` to override). macOS is
assumed for the email feature (uses the Mail app); everything else is cross-platform.

```bash
npm test            # run the automated test suite (node:test, no extra deps)
npm run gallery     # regenerate the assignment's offline output gallery
npm run scale       # run the 50-domain stress test
PORT=5000 npm start # use a different port
```

---

## What it does

| Feature | Where |
|---|---|
| **Live WCAG audit** — system Chrome + axe-core, full A/AA ruleset | [src/scanner.js](src/scanner.js) |
| **Multi-page crawl** — follow same-origin links (1–10 pages) | [src/scanner.js](src/scanner.js) |
| **Element screenshots** — top violations captured with a red highlight box | [src/scanner.js](src/scanner.js) |
| **Deterministic scans** — freezes animations, waits for fonts, triggers lazy content, dismisses cookie banners, so a re-scan of an unchanged site is identical | [src/scanner.js](src/scanner.js) |
| **Confidence warnings** — flags likely consent/bot walls so a result is never silently wrong | [src/scanner.js](src/scanner.js) |
| **Diff / score engine** — new vs persisting vs resolved, severity-weighted score | [pipeline.js](pipeline.js) |
| **Time-series tracking** — each scan diffs against the previous stored scan of that domain | [src/server.js](src/server.js) |
| **Concrete fix suggestions** — per-rule knowledge base + axe's failure summary (and optional real Claude API) | [src/livefix.js](src/livefix.js) |
| **Persistence** — every scan, its artifacts, violations, and screenshots | [src/db.js](src/db.js) (SQLite) |
| **Analytics & trends dashboards** — charts built from the database | [src/analytics.js](src/analytics.js) |
| **Scheduled monitoring** — auto re-scan watched sites, email alert only on regression | [src/server.js](src/server.js) |
| **Email delivery** — report sent via the macOS Mail app (no API key needed) | [src/server.js](src/server.js) |
| **Dogfooding** — the UI is itself accessible; a "🪞 This app" button audits the tool with its own engine | [public/index.html](public/index.html) |

---

## Architecture

```
 Browser UI (public/index.html)
        │  fetch
        ▼
 HTTP server (src/server.js) ── scheduler ──► re-scan watched sites, email on regression
        │
        ├── src/scanner.js   → headless Chrome + axe-core  (live "Node 5" audit)
        ├── pipeline.js      → diff → filter → merge → render  (n8n nodes 6/7/9/10)
        ├── src/livefix.js   → concrete fix suggestions for live scans
        ├── src/analytics.js → SVG dashboards from aggregated data
        └── src/db.js        → SQLite: scans, violations, evidence, watches
```

### Project layout

```
.
├── src/              app code: server.js, scanner.js, pipeline⇄, livefix.js, analytics.js, db.js
│                     (server reaches up to ../pipeline.js, the shared engine)
├── public/           index.html — the single-page UI
├── test/             monitor.test.js (run with `npm test`)
├── data/             SQLite database (created at runtime)
├── outputs/          assignment output gallery
├── pipeline.js       shared diff/score/render engine (used by the app AND the assignment scripts)
├── generate_outputs.js · scale_test_50.js · screenshot_helper.js   assignment scripts (run from root)
└── Assignment4_Singh_Kanishk.{html,pdf} · workflow_v2*.json · …    assignment deliverables
```

Optional: set `ANTHROPIC_API_KEY` and live critical/serious findings get a real
`claude-sonnet-4-6` fix suggestion; otherwise the rule-based knowledge base is used.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/scan` | Live scan a URL (`{ url, maxPages }`), diff vs history, persist |
| `POST` | `/run` | Run the pipeline on manually-entered violations |
| `GET` | `/api/scans` | List saved scans |
| `GET` | `/api/scans/:id` | Fetch one saved scan (artifacts + violations + evidence) |
| `DELETE` | `/api/scans/:id` | Delete a saved scan |
| `GET` | `/api/trends` | Cross-domain trends dashboard (HTML) |
| `GET` | `/api/analytics` | Analytics dashboard with charts (HTML) |
| `GET/POST` | `/api/watches` | List / add a monitored site |
| `DELETE` | `/api/watches/:id` | Stop monitoring a site |
| `POST` | `/send` | Email the report via the Mail app |
| `GET` | `/preset/:name` | Load assignment demo data (example.com, shopmart.io, techblog.dev) |

---

## Data

SQLite at `data/monitor.db` (override with `MONITOR_DB`). Tables: `scans`,
`violations`, `evidence`, `watches`. Inspect it directly:

```bash
sqlite3 data/monitor.db "SELECT id, domain, current_score, created_at FROM scans;"
```

Reset history: stop the server and `rm data/monitor.db*`.

---

## Known limitations (honest)

- **One DOM snapshot per page.** axe audits the rendered DOM; it can't catch
  keyboard-trap or screen-reader-only issues that need interaction.
- **Consent / bot / login walls.** Headless Chrome is sometimes shown a different
  page than a real user. The tool auto-dismisses common cookie banners and
  **warns** when a scan looks low-confidence, but auth-gated pages can't be audited.
- **Score is a heuristic** (severity-weighted), useful for tracking trends — not an
  official conformance grade.
- **Email** uses the macOS Mail app, so it's macOS-only and sends from whatever
  account Mail is signed into.

---

## Tests

`npm test` covers the diff/score engine, the fix knowledge base, the scanner's
mapping helpers, the analytics renderer, and a full DB round-trip (against a
throwaway database) — including the page-URL stable-key behaviour that keeps
re-scans of an unchanged site consistent.
