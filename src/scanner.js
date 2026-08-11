/**
 * scanner.js — REAL WCAG audit (the live version of workflow "Node 5")
 *
 * Launches the system Google Chrome headless via puppeteer-core, injects
 * axe-core 4.x, runs the full WCAG 2.0/2.1/2.2 A+AA ruleset, and maps each real
 * violation into the SAME shape pipeline.js consumes.
 *
 * Extras that make it stand out:
 *   • multi-page CRAWL — follow same-origin links up to N pages and aggregate
 *   • element SCREENSHOTS — capture each top violation with a red highlight box
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const AXE_SRC = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.env.CHROME_PATH
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH.');
  return hit;
}

// axe tags like "wcag111", "wcag2aa", "wcag412" -> human criterion "1.1.1"
function wcagFromTags(tags = []) {
  const t = tags.find(x => /^wcag\d{3,4}$/.test(x));
  if (!t) return '—';
  return t.replace('wcag', '').split('').join('.');
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) throw new Error('Enter a website URL to scan.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`"${raw}" is not a valid URL.`); }
  return parsed.toString();
}

const SEV_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1 };

/* Best-effort dismissal of cookie-consent / GDPR banners so we audit the real
 * site, not an interstitial. Clicks the first matching "accept" control if found. */
async function dismissConsent(page) {
  try {
    const clicked = await page.evaluate(() => {
      const RX = /^(accept all|accept|allow all|agree|i agree|got it|ok|allow cookies|accept cookies|continue)$/i;
      const cands = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'));
      for (const el of cands) {
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        if (label && RX.test(label)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return label; }
        }
      }
      return null;
    });
    if (clicked) await new Promise(r => setTimeout(r, 400)); // let the banner close
    return clicked;
  } catch { return null; }
}

/* Put the page into a DETERMINISTIC, settled state before auditing so repeated
 * scans of an unchanged site produce the IDENTICAL violation set (no phantom
 * new/resolved from animations, web-font swaps, or lazy/scroll-reveal content). */
async function stabilize(page) {
  // 1) Kill animations/transitions/smooth-scroll so layout & styles are final.
  await page.addStyleTag({ content:
    `*,*::before,*::after{animation:none!important;animation-duration:0s!important;` +
    `transition:none!important;transition-duration:0s!important;scroll-behavior:auto!important;}`
  }).catch(() => {});
  // 2) Wait for web fonts, then walk the page to trigger lazy / IntersectionObserver content.
  await page.evaluate(async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
    const h = (document.body && document.body.scrollHeight) || 0;
    for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 50));
  }).catch(() => {});
  // 3) Final settle so any post-scroll work finishes before axe reads the DOM.
  await new Promise(r => setTimeout(r, 500));
}

/* Run axe on an already-loaded page; return per-node violations in pipeline shape. */
async function auditPage(page, pageUrl, scanId, scanDate, startIdx) {
  await page.evaluate(AXE_SRC);
  const results = await page.evaluate(async () => {
    return await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations']
    });
  });
  const violations = [];
  let idx = startIdx;
  for (const v of results.violations) {
    for (const node of v.nodes) {
      const checks = [...(node.any || []), ...(node.all || []), ...(node.none || [])];
      const dataCheck = checks.find(c => c.data && typeof c.data === 'object');
      violations.push({
        rule_id: v.id,
        wcag_criterion: wcagFromTags(v.tags),
        impact: v.impact || 'moderate',
        selector: Array.isArray(node.target) ? node.target.join(' ') : String(node.target),
        html_snippet: (node.html || '').slice(0, 400),
        description: v.help || v.description,
        help_url: v.helpUrl,
        failure_summary: (node.failureSummary || '').replace(/\s*\n\s*/g, ' ').trim(),
        fix_data: dataCheck ? dataCheck.data : null,
        page_url: pageUrl,
        violation_id: `${scanId}_${v.id}_${idx}`,
        scan_id: scanId,
        collected_at: scanDate
      });
      idx++;
    }
  }
  return { violations, engine: results.testEngine ? `${results.testEngine.name} ${results.testEngine.version}` : 'axe-core' };
}

/* Screenshot the worst violations on the current page, each with a red highlight. */
async function captureEvidence(page, violations, budget) {
  const out = [];
  const ranked = [...violations].sort((a, b) => (SEV_RANK[b.impact] || 0) - (SEV_RANK[a.impact] || 0));
  const seen = new Set();
  for (const v of ranked) {
    if (out.length >= budget) break;
    if (seen.has(v.selector)) continue;
    seen.add(v.selector);
    try {
      const el = await page.$(v.selector);
      if (!el) continue;
      const box = await el.boundingBox();
      // Skip slivers (decorative spacer gifs etc.) and oversized elements.
      if (!box || box.width < 16 || box.height < 12 || box.width > 1600 || box.height > 1600) continue;
      await el.evaluate(e => {
        e.dataset.__a11yOutline = e.style.outline || '';
        e.style.outline = '3px solid #E0533B';
        e.style.outlineOffset = '2px';
        e.scrollIntoView({ block: 'center', inline: 'center' });
      });
      await new Promise(r => setTimeout(r, 120));
      const buf = await el.screenshot({ type: 'png' }).catch(() => null);
      await el.evaluate(e => { e.style.outline = e.dataset.__a11yOutline || ''; delete e.dataset.__a11yOutline; }).catch(() => {});
      if (!buf) continue;
      out.push({
        rule_id: v.rule_id, impact: v.impact, selector: v.selector, page_url: v.page_url,
        screenshot: 'data:image/png;base64,' + Buffer.from(buf).toString('base64')
      });
    } catch { /* skip un-screenshottable elements */ }
  }
  return out;
}

/* Heuristic: did we actually audit the real site, or a consent/bot/redirect wall?
 * Returns a human warning string (or null). Keeps the result honest on "any" site. */
async function assessConfidence(page, startUrl) {
  let info;
  try {
    info = await page.evaluate(() => ({
      els: document.querySelectorAll('*').length,
      title: document.title || '',
      text: (document.body ? document.body.innerText : '').slice(0, 600)
    }));
  } catch { return null; }
  const finalUrl = page.url();
  const reasons = [];
  try {
    const a = new URL(startUrl).hostname.replace(/^www\./, '');
    const b = new URL(finalUrl).hostname.replace(/^www\./, '');
    if (a && b && a !== b) reasons.push(`redirected to ${b}`);
  } catch { /* ignore */ }
  if (info.els < 60) reasons.push(`the page loaded very little content (${info.els} elements)`);
  if (/just a moment|attention required|access denied|are you (a )?human|verify (you|that)|captcha|please enable javascript|cookie (policy|consent|preferences)|consent|accept cookies/i
      .test(`${info.title} ${info.text}`)) {
    reasons.push('it looks like a cookie-consent or bot-verification wall');
  }
  return reasons.length
    ? `Results may be incomplete: ${reasons.join('; ')}. Headless browsers can be shown a different page than real users — treat this scan as low-confidence.`
    : null;
}

/* Collect same-origin, http(s) links from the current page (deduped, no hash/file). */
async function sameOriginLinks(page, origin) {
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href));
  const out = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h);
      if (u.origin !== origin) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      if (/\.(pdf|zip|png|jpe?g|gif|svg|mp4|mp3|css|js|ico|woff2?)$/i.test(u.pathname)) continue;
      u.hash = '';
      out.push(u.toString());
    } catch { /* ignore */ }
  }
  return [...new Set(out)];
}

/**
 * Scan one page, or crawl up to `maxPages` same-origin pages.
 * Returns { domain, scanId, scanDate, pageUrl, pagesScanned[], tested, violations[], evidence[] }.
 */
async function scanUrl(rawUrl, { timeoutMs = 30000, maxPages = 1, shots = 10 } = {}) {
  const startUrl = normalizeUrl(rawUrl);
  const origin = new URL(startUrl).origin;
  const domain = new URL(startUrl).host;
  const now = new Date();
  const scanDate = now.toISOString().slice(0, 10);
  const scanId = 'scan_' + now.toISOString().replace(/[-:T]/g, '').slice(0, 14) + '_live';
  maxPages = Math.max(1, Math.min(20, maxPages | 0));

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
    // A standard desktop-Chrome UA: custom UAs get blocked by some sites' WAFs.
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    // Reduced-motion makes sites that honour it render static — fewer animation races.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]).catch(() => {});

    const queue = [startUrl];
    const visited = new Set();
    const pagesScanned = [];
    let violations = [];
    let evidence = [];
    let engine = 'axe-core';
    let idx = 0;
    let warning = null;

    while (queue.length && pagesScanned.length < maxPages) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      // domcontentloaded is reliable everywhere; networkidle2 hangs on chatty
      // sites (analytics/ads/websockets). Then best-effort wait for the network
      // to quiet, so we still capture late-rendered content when it does settle.
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null);
      if (url === startUrl && !resp) throw new Error(`Could not load ${startUrl}.`);
      if (!resp || resp.status() >= 400) {
        if (url === startUrl) throw new Error(`${startUrl} returned HTTP ${resp ? resp.status() : 'no response'}.`);
        continue;
      }
      await page.waitForNetworkIdle({ idleTime: 600, timeout: 9000 }).catch(() => {});
      await dismissConsent(page);
      await stabilize(page);
      const audit = await auditPage(page, url, scanId, scanDate, idx);
      idx += audit.violations.length;
      engine = audit.engine;
      violations = violations.concat(audit.violations);
      pagesScanned.push(url);

      // On the entry page, judge whether we actually saw the real site (vs a
      // consent/bot/redirect wall) so the result isn't silently misleading.
      if (url === startUrl) warning = await assessConfidence(page, startUrl);

      if (evidence.length < shots) {
        const ev = await captureEvidence(page, audit.violations, shots - evidence.length);
        evidence = evidence.concat(ev);
      }
      // Enqueue more same-origin links only while we still need pages
      if (maxPages > 1 && pagesScanned.length < maxPages) {
        for (const link of await sameOriginLinks(page, origin)) {
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }
      }
    }

    return { domain, scanId, scanDate, pageUrl: startUrl, pagesScanned, tested: engine, violations, evidence, warning };
  } finally {
    await browser.close();
  }
}

module.exports = { scanUrl, normalizeUrl, wcagFromTags };
