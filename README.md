# AccessDrift

A full-stack web-accessibility monitoring tool. Paste a URL → it launches a real
headless Chrome, runs **axe-core** against the live page(s) across the full
**WCAG 2.0 / 2.1 / 2.2 A & AA** ruleset, and produces an audit report, an email
digest, a CSV, and screenshot evidence — then tracks how the site changes over
time and can email you when accessibility **regresses**. A companion "Fix"
mode can also auto-repair the safe, deterministic issues (missing `alt`,
`lang`, labels, accessible names) directly in a pasted HTML file.

Under the hood this is the "Accessibility Monitor v2" engine, built on top of
an earlier assignment's n8n workflow logic ([pipeline.js](pipeline.js) — the
diff → filter → merge → render pipeline), extended into a real deployed app.

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

The server reads `public/index.html` into memory once at boot — after editing
the frontend, restart the server to see the change.

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
| **Multi-page crawl** — follow same-origin links (1–20 pages) | [src/scanner.js](src/scanner.js) |
| **Element screenshots** — top violations captured with a red highlight box | [src/scanner.js](src/scanner.js) |
| **Deterministic scans** — freezes animations, waits for fonts, triggers lazy content, dismisses cookie banners, so a re-scan of an unchanged site is identical | [src/scanner.js](src/scanner.js) |
| **Confidence warnings** — flags likely consent/bot walls so a result is never silently wrong | [src/scanner.js](src/scanner.js) |
| **Diff / score engine** — new vs persisting vs resolved, severity-weighted score | [pipeline.js](pipeline.js) |
| **Time-series tracking** — each scan diffs against the previous stored scan of that domain (keyed by host, so ports are respected) | [src/server.js](src/server.js) |
| **Auto-fix mode** — deterministically repairs safe issues (alt text, labels, lang, accessible names) in a pasted HTML file and re-scans to prove the score improved | [src/autofix.js](src/autofix.js) |
| **Concrete fix suggestions** — per-rule knowledge base + axe's failure summary (and optional real Claude API) | [src/livefix.js](src/livefix.js) |
| **Persistence** — every scan, its artifacts, violations, and screenshots | [src/db.js](src/db.js) (SQLite) |
| **Analytics & trends dashboards** — charts built from the database | [src/analytics.js](src/analytics.js) |
| **Scheduled monitoring** — auto re-scan watched sites, email alert only on regression | [src/server.js](src/server.js) |
| **Email delivery** — report sent via the macOS Mail app (no API key needed) | [src/server.js](src/server.js) |
| **Dogfooding** — the UI is itself accessible and scannable like any other target | [public/index.html](public/index.html) |

Optional: set `ANTHROPIC_API_KEY` and live critical/serious findings (and
Auto-fix's alt/label text) get real `claude-sonnet-4-6`-written suggestions;
otherwise a rule-based knowledge base is used and every feature still works.

---

## Architecture

```
 Browser UI (public/index.html)
        │  fetch
        ▼
 HTTP server (src/server.js) ── scheduler ──► re-scan watched sites, email on regression
        │
        ├── src/scanner.js   → headless Chrome + axe-core  (live audit)
        ├── pipeline.js      → diff → filter → merge → render  (score/report engine)
        ├── src/livefix.js   → concrete fix suggestions for live scans
        ├── src/autofix.js   → deterministic auto-repair of a pasted HTML file
        ├── src/analytics.js → SVG dashboards from aggregated data
        └── src/db.js        → SQLite: scans, violations, evidence, watches
```

### Project layout

```
.
├── src/              app code: server.js, scanner.js, livefix.js, autofix.js, analytics.js, db.js
│                     (server reaches up to ../pipeline.js, the shared engine)
├── public/           index.html — the single-page UI
├── test/             monitor.test.js (run with `npm test`)
├── data/             SQLite database (created at runtime; gitignored)
├── pipeline.js       shared diff/score/render engine (used by the app AND the assignment scripts)
├── Dockerfile        Node 20 + system Chromium, used for the Render deployment
├── render.yaml       Render blueprint (Docker web service, free plan)
├── generate_outputs.js · scale_test_50.js · screenshot_helper.js   assignment scripts (run from root)
└── Assignment4_Singh_Kanishk.{html,pdf} · workflow_v2*.json · …    assignment deliverables
```

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/scan` | Live scan a URL (`{ url, maxPages }`), diff vs history, persist |
| `POST` | `/fix` | Auto-repair safe issues in a pasted HTML string (`{ html }`), returns before/after + change log |
| `POST` | `/run` | Run the pipeline on manually-entered violations |
| `GET` | `/api/scans` | List saved scans |
| `GET` | `/api/scans/:id` | Fetch one saved scan (artifacts + violations + evidence) |
| `DELETE` | `/api/scans/:id` | Delete a saved scan |
| `GET` | `/api/trends` | Cross-domain trends dashboard (HTML) |
| `GET` | `/api/analytics` | Analytics dashboard with charts (HTML) |
| `GET/POST` | `/api/watches` | List / add a monitored site |
| `DELETE` | `/api/watches/:id` | Stop monitoring a site |
| `POST` | `/send` | Email the report via the Mail app (macOS only) |
| `GET` | `/preset/:name` | Load assignment demo data (example.com, shopmart.io, techblog.dev) |
| `GET` | `/rules` | Which rule IDs have a captured Claude fix vs the rule-based fallback |

---

## Data

SQLite at `data/monitor.db` (override with `MONITOR_DB`). Tables: `scans`,
`violations`, `evidence`, `watches`. Inspect it directly:

```bash
sqlite3 data/monitor.db "SELECT id, domain, current_score, created_at FROM scans;"
```

Reset history: stop the server and `rm data/monitor.db*`.

---

## Deployment

The live demo runs on [Render](https://render.com) as a Docker web service
(`render.yaml` → `Dockerfile`, Node 20-slim + system `chromium`, `CHROME_PATH`
set accordingly). Push to `main` to redeploy.

**Known gap:** the free-plan service has no persistent disk attached, so
`data/monitor.db` lives on the container's ephemeral filesystem — scan
history, trends, and watches are wiped on every redeploy. Fine for demoing a
single scan; not durable for real long-term monitoring without a paid plan
and an attached disk (or an external hosted database).

---

## Known limitations (honest)

- **One DOM snapshot per page.** axe audits the rendered DOM; it can't catch
  keyboard-trap or screen-reader-only issues that need interaction.
- **Consent / bot / login walls.** Headless Chrome is sometimes shown a different
  page than a real user. The tool auto-dismisses common cookie banners and
  **warns** when a scan looks low-confidence, but auth-gated pages can't be audited.
- **Score is a heuristic** (severity-weighted, exponential decay so it never
  flattens every badly-broken page to the same 0), useful for tracking trends —
  not an official conformance grade.
- **Email** uses the macOS Mail app, so it's macOS-only and sends from whatever
  account Mail is signed into — it doesn't work on the deployed (Linux) instance.
- **No persistent disk on the live deployment** — see [Deployment](#deployment).

---

## Tests

`npm test` covers the diff/score engine, the fix knowledge base, the scanner's
mapping helpers, the analytics renderer, and a full DB round-trip (against a
throwaway database) — including the page-URL stable-key behaviour that keeps
re-scans of an unchanged site consistent.
