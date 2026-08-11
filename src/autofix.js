/**
 * autofix.js — "Fix" mode.
 *
 * Takes a LOCAL html file (or raw HTML string), scans it with axe-core, applies
 * the *deterministic, high-confidence* fixes, then re-scans to prove the score
 * went up. Returns before/after + a change log.
 *
 * Source-mapping trick: axe reports failing elements as CSS selectors that
 * resolve in the live DOM. We tag each element in that DOM, apply fixes there,
 * then serialize the DOM back to HTML — so "find the element in source" is free.
 *
 * MEANINGFUL LABELS: for rules that need human-readable text (alt / aria-label),
 * with ANTHROPIC_API_KEY set we ask Claude for concise, meaningful wording in a
 * single batched call. Without a key (or on error) we fall back to text derived
 * from the element (href segment, placeholder, etc.).
 *
 * SAFE (auto-applied):
 *   html-has-lang / html-lang-valid, document-title, image-alt, input-image-alt,
 *   label, link-name, button-name, scrollable-region-focusable, frame-title
 * Everything else (color-contrast, heading-order, target-size, …) is reported
 * as "needs human review" and left untouched.
 */
const puppeteer = require('puppeteer-core');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AXE_SRC = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.env.CHROME_PATH,
].filter(Boolean);
function findChrome() {
  const hit = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH.');
  return hit;
}

// Same severity weights + score formula as server.js's live absolute score, so
// before/after numbers line up with a normal /scan.
const SEV = { critical: 8, serious: 3, moderate: 1, minor: 1 };
const scoreOf = violations =>
  Math.round(100 * Math.exp(-violations.reduce((s, v) => s + (SEV[v.impact] || 1), 0) / 100));

const AUTO_FIXABLE = new Set([
  'html-has-lang', 'html-lang-valid', 'document-title', 'image-alt',
  'input-image-alt', 'label', 'link-name', 'button-name',
  'scrollable-region-focusable', 'frame-title',
]);
// Rules whose fix is a piece of human-readable text a model can improve.
const LABEL_RULES = new Set(['image-alt', 'input-image-alt', 'label', 'link-name', 'button-name']);

async function runAxe(page) {
  await page.evaluate(AXE_SRC);
  const results = await page.evaluate(async () =>
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    }));
  const out = [];
  for (const v of results.violations)
    for (const node of v.nodes)
      out.push({
        rule_id: v.id,
        impact: v.impact || 'moderate',
        selector: Array.isArray(node.target) ? node.target.join(' ') : String(node.target),
        help: v.help,
      });
  return out;
}

/* ---- Phase 1 (browser): tag each fixable element, extract context ---- */
function collectTargets(violations) {
  let n = 0;
  const targets = [];
  // Idempotent: html-has-lang and document-title both tag <html> — reuse its id
  // instead of minting a new one, or the second tag() call overwrites the first
  // and the earlier target's [data-afix] selector stops matching anything.
  const tag = el => {
    if (el.hasAttribute('data-afix')) return el.getAttribute('data-afix');
    const id = String(n++); el.setAttribute('data-afix', id); return id;
  };
  for (const v of violations) {
    if (['html-has-lang', 'html-lang-valid', 'document-title'].includes(v.rule_id)) {
      targets.push({ id: tag(document.documentElement), rule: v.rule_id });
      continue;
    }
    let els = [];
    try { els = [...document.querySelectorAll(v.selector)]; } catch { els = []; }
    for (const el of els) {
      if (el.hasAttribute('data-afix')) continue; // one fix per element
      targets.push({
        id: tag(el),
        rule: v.rule_id,
        tag: el.tagName.toLowerCase(),
        snippet: (el.outerHTML || '').slice(0, 300),
        src: el.getAttribute('src') || '',
        href: el.getAttribute('href') || '',
        placeholder: el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        title: el.getAttribute('title') || '',
        cls: el.getAttribute('class') || '',
        near: ((el.closest('form,section,article,nav,header,main,div') || {}).textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    }
  }
  return targets;
}

/* ---- Phase 2 (browser): apply fixes, using AI labels when provided ---- */
function applyResolved(targets) {
  const log = [];
  // html-has-lang and document-title can share one id (both target <html>) — only
  // strip data-afix once every target for that id has been processed, or the
  // first removal breaks the querySelector lookup for the second.
  const remaining = {};
  for (const t of targets) remaining[t.id] = (remaining[t.id] || 0) + 1;
  const fallback = t => {
    if (t.href) {
      if (t.href === '/' || /(^|\/)(index|home)(\.html?)?$/i.test(t.href)) return 'Home';
      const seg = t.href.split(/[?#]/)[0].split('/').filter(Boolean).pop() || t.href;
      return decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim() || 'link';
    }
    return (t.placeholder || t.name || t.title || t.cls || '')
      .split(/\s+/)[0]                       // first class token, e.g. "wishlist-toggle"
      .replace(/[-_]+/g, ' ').trim();
  };
  for (const t of targets) {
    const el = document.querySelector(`[data-afix="${t.id}"]`);
    if (!el) continue;
    const ai = typeof t.label === 'string';          // AI returned something (may be "")
    let note = null;
    switch (t.rule) {
      case 'html-has-lang': case 'html-lang-valid':
        document.documentElement.setAttribute('lang', 'en'); note = 'set <html lang="en">'; break;
      case 'document-title':
        if (!document.querySelector('title')) {
          const el2 = document.createElement('title');
          el2.textContent = (document.body && document.body.getAttribute('data-title')) || 'Page';
          (document.head || document.documentElement).appendChild(el2);
          note = `added <title>${el2.textContent}</title>`;
        }
        break;
      case 'image-alt': {
        const alt = ai ? t.label : (fallback(t) || '');
        el.setAttribute('alt', alt);
        note = alt ? `added alt="${alt}"${ai ? ' (Claude)' : ''}` : 'added alt="" (decorative)';
        break;
      }
      case 'input-image-alt': {
        const alt = (ai && t.label) || el.getAttribute('value') || el.getAttribute('name') || 'Submit';
        el.setAttribute('alt', alt); note = `added alt="${alt}"${ai ? ' (Claude)' : ''}`; break;
      }
      case 'label': {
        const lbl = (ai && t.label) || fallback(t) || 'Field';
        el.setAttribute('aria-label', lbl); note = `added aria-label="${lbl}"${ai && t.label ? ' (Claude)' : ''}`; break;
      }
      case 'link-name': case 'button-name': {
        const lbl = (ai && t.label) || fallback(t) || (t.tag === 'a' ? 'link' : 'button');
        el.setAttribute('aria-label', lbl); note = `added aria-label="${lbl}"${ai && t.label ? ' (Claude)' : ''}`; break;
      }
      case 'scrollable-region-focusable':
        if (!el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '0'); note = 'added tabindex="0"'; } break;
      case 'frame-title':
        if (!el.getAttribute('title')) { el.setAttribute('title', (ai && t.label) || el.getAttribute('name') || 'Embedded content'); note = `added title="${el.getAttribute('title')}"`; } break;
    }
    remaining[t.id]--;
    if (remaining[t.id] === 0) el.removeAttribute('data-afix');
    if (note) log.push({ rule: t.rule, selector: t.snippet ? t.snippet.slice(0, 80) : t.rule, change: note, ai: ai && !!t.label });
  }
  return log;
}

/* ---- Batched Claude call for meaningful alt/label text ---- */
function generateLabels(targets) {
  const items = targets.filter(t => LABEL_RULES.has(t.rule));
  if (!items.length || !process.env.ANTHROPIC_API_KEY) return Promise.resolve(null);

  const prompt = `You are an accessibility expert writing concise accessible names and alt text.
For each element below, choose the best human-readable text:
- rule "image-alt"/"input-image-alt": alt text. If the image is purely decorative, return "" (empty).
- rule "link-name"/"button-name": a short accessible name (what it does / where it goes).
- rule "label": a form field label.
Rules: 1-5 words, natural, NO "image of"/"link to"/"button". Use the filename, href, placeholder and nearby text as clues.

Elements (JSON):
${JSON.stringify(items.map(t => ({ id: t.id, rule: t.rule, tag: t.tag, src: t.src, href: t.href, placeholder: t.placeholder, name: t.name, near: t.near, html: t.snippet })), null, 0)}

Respond with ONLY a JSON array: [{"id":"<id>","text":"<label or empty string>"}]`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) { console.warn('  label AI failed:', res.statusCode); return resolve({}); }
          const text = JSON.parse(raw).content.map(b => b.text || '').join('');
          const arr = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
          const map = {};
          for (const o of arr) if (o && o.id != null) map[String(o.id)] = String(o.text || '');
          resolve(map);
        } catch (e) { console.warn('  label AI parse error:', e.message); resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(30000, () => req.destroy());
    req.write(body); req.end();
  });
}

async function fixLoadedPage(page) {
  const before = await runAxe(page);
  const fixable = before.filter(v => AUTO_FIXABLE.has(v.rule_id));
  const targets = await page.evaluate(collectTargets, fixable);

  const labels = await generateLabels(targets);          // {id:text} | {} | null
  const usedAI = !!labels && Object.keys(labels).length > 0;
  if (labels) for (const t of targets) if (t.id in labels) t.label = labels[t.id];

  const applied = await page.evaluate(applyResolved, targets);
  const fixedHtml = await page.evaluate(() => '<!DOCTYPE html>\n' + document.documentElement.outerHTML);

  const skipped = before
    .filter(v => !AUTO_FIXABLE.has(v.rule_id))
    .map(v => ({ rule: v.rule_id, impact: v.impact, selector: v.selector, help: v.help }));

  return { before, applied, skipped, fixedHtml, usedAI };
}

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'],
  });
  try { return await fn(browser); } finally { await browser.close(); }
}

function shape(r, after, outPath) {
  return {
    before: { count: r.before.length, score: scoreOf(r.before) },
    after: { count: after.length, score: scoreOf(after) },
    applied: r.applied,
    skipped: r.skipped,
    usedAI: r.usedAI,
    fixedHtml: r.fixedHtml,
    outPath: outPath || null,
  };
}

/** Fix a local HTML file; writes <name>.fixed.html unless write:false. */
async function fixFile(inputPath, { write = true } = {}) {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return withBrowser(async browser => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto('file://' + abs, { waitUntil: 'domcontentloaded' });
    const r = await fixLoadedPage(page);

    const outPath = abs.replace(/\.html?$/i, '') + '.fixed.html';
    if (write) fs.writeFileSync(outPath, r.fixedHtml, 'utf8');

    const verifyPath = write ? outPath : (() => {
      const tmp = path.join(os.tmpdir(), `afix_verify_${process.pid}.html`);
      fs.writeFileSync(tmp, r.fixedHtml, 'utf8'); return tmp;
    })();
    const vp = await browser.newPage();
    await vp.goto('file://' + verifyPath, { waitUntil: 'domcontentloaded' });
    const after = await runAxe(vp);
    if (!write) fs.unlinkSync(verifyPath);
    return shape(r, after, write ? outPath : null);
  });
}

/** Fix a raw HTML string (used by the /fix HTTP endpoint). Writes nothing. */
async function fixHtmlString(html) {
  if (!html || !html.trim()) throw new Error('No HTML provided.');
  const tmp = path.join(os.tmpdir(), `afix_${process.pid}_${html.length}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  try {
    const r = await fixFile(tmp, { write: false });
    return r; // includes fixedHtml
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { fixFile, fixHtmlString, scoreOf, AUTO_FIXABLE };
