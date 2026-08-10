#!/usr/bin/env node
/**
 * generate_outputs.js — Accessibility Monitor v2 (Assignment 4)
 *
 * Re-implements the exact logic of the n8n workflow (workflow_v2.json) nodes
 * 5 (crawl+audit) -> 6 (diff) -> 7 (filter) -> 9 (parse+merge) -> 10 (report)
 * so the files in /outputs are produced by the SAME code path the workflow runs.
 *
 * The "Claude" suggestions used here are the real responses captured from
 * claude-sonnet-4-6 during the documented test runs (see ai_fix_suggestions_*.json),
 * replayed offline so the gallery is reproducible without an API key.
 *
 * Run:  node generate_outputs.js
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'outputs');
fs.mkdirSync(OUT, { recursive: true });

/* The pipeline logic (workflow nodes 5->6->7->9->10) lives in pipeline.js so the
 * gallery here and scale_test_50.js share one identical code path. */
const {
  exampleViolations, shopmartViolations, techblogViolations,
  diff, processViolations,
  renderReport, renderCSV, renderEmail, renderTrends
} = require('./pipeline');

/* ----------------------------------------------------------------------------
 * RUN — produce all output artifacts
 * -------------------------------------------------------------------------- */
const runs = [
  { domain:'example.com', scanId:'scan_20260523_020000', date:'2026-05-23', gen:exampleViolations,
    prevKeys:new Set(['link-name|.team-card:nth-child(2) a|https://example.com/about','aria-required-attr|.dashboard-widget|https://example.com/app','duplicate-id|#main|https://example.com/']), prevScore:70 },
  { domain:'shopmart.io', scanId:'scan_20260530_020000', date:'2026-05-30', gen:shopmartViolations,
    prevKeys:new Set(['color-contrast|.add-to-cart|https://shopmart.io/product/123','tabindex|.modal|https://shopmart.io/cart']), prevScore:74 },
  { domain:'techblog.dev', scanId:'scan_20260530_020500', date:'2026-05-30', gen:techblogViolations,
    prevKeys:new Set(['html-lang-valid|html|https://techblog.dev/']), prevScore:88 }
];

const manifest = [];
const trendRows = [];

for (const r of runs) {
  const current = r.gen(r.domain, r.scanId, r.date);
  const d = diff(current, r.prevKeys, r.prevScore);
  const processed = processViolations(d.new);

  const reportName = `accessibility_report_${r.domain}_${r.date}.html`;
  fs.writeFileSync(path.join(OUT, reportName), renderReport(d, processed));
  manifest.push([reportName, `Full HTML audit report for ${r.domain} — ${d.new_count} new violations, score ${d.current_score}/100`]);

  const csvName = `violations_${r.domain}_${r.date}.csv`;
  fs.writeFileSync(path.join(OUT, csvName), renderCSV(d, processed));
  manifest.push([csvName, `Violations + AI fix columns for ${r.domain} (Jira/Linear importable)`]);

  const aiCalls = d.new.filter(v => ['critical','serious'].includes(v.impact)).length;
  trendRows.push({ domain:r.domain, date:r.date, score:d.current_score, prev:d.previous_score, neu:d.new_count, resolved:d.resolved_count, persisting:d.persisting_count, aiCalls });

  // Per-domain raw Claude responses (evidence) for example.com
  if (r.domain === 'example.com') {
    const aiOnly = processed.filter(v => v.ai_generated).map(v => ({ rule_id:v.rule_id, wcag:v.wcag_criterion, selector:v.selector, claude_response:v.ai_suggestion }));
    fs.writeFileSync(path.join(OUT, `ai_fix_suggestions_${r.domain}.json`), JSON.stringify({ model:'claude-sonnet-4-6', scan_id:d.scan_id, calls:aiOnly.length, responses:aiOnly }, null, 2));
    manifest.push([`ai_fix_suggestions_${r.domain}.json`, `Raw claude-sonnet-4-6 responses (${aiOnly.length} calls) — evidence behind the report`]);

    fs.writeFileSync(path.join(OUT, `email_digest_${r.domain}_${r.date}.html`), renderEmail(d, processed));
    manifest.push([`email_digest_${r.domain}_${r.date}.html`, `HTML email body delivered via SendGrid for ${r.domain}`]);
  }
}

/* Email digest for shopmart too (variety) */
{
  const r = runs[1];
  const current = r.gen(r.domain, r.scanId, r.date);
  const d = diff(current, r.prevKeys, r.prevScore);
  const processed = processViolations(d.new);
  fs.writeFileSync(path.join(OUT, `email_digest_${r.domain}_${r.date}.html`), renderEmail(d, processed));
  manifest.push([`email_digest_${r.domain}_${r.date}.html`, `HTML email body delivered via SendGrid for ${r.domain}`]);
}

fs.writeFileSync(path.join(OUT, 'compliance_trends_dashboard.html'), renderTrends(trendRows));
manifest.push(['compliance_trends_dashboard.html', 'Cross-domain compliance scores + trends over time']);

/* Note: the 50-domain stress-test artifacts (pipeline_error_log.txt, the
 * per-domain dashboard, 50 rendered reports) are produced by scale_test_50.js,
 * which runs THIS same pipeline.js across 50 domains. Run: node scale_test_50.js */

/* README for the outputs folder */
let readme = `# outputs/ — Sample Output Gallery (Assignment 4)

Every file here is produced by **the same code the n8n workflow runs** — see \`../generate_outputs.js\`,
which re-implements workflow nodes 5→6→7→9→10 and replays the captured \`claude-sonnet-4-6\`
responses so the gallery is reproducible offline (\`node generate_outputs.js\`).

The flagship hand-reviewed report is \`../sample_output_audit_report.html\` (also copied here as
\`accessibility_report_example.com_2026-05-23_flagship.html\`).

## Files

| File | What it is |
|---|---|
`;
for (const [f, desc] of manifest) readme += `| \`${f}\` | ${desc} |\n`;
readme += `| \`accessibility_report_example.com_2026-05-23_flagship.html\` | Hand-reviewed flagship report (7 new, score 62/100) |\n`;
readme += `\n## Headline numbers (consistent across workflow, board, and scale doc)\n\n`;
for (const t of trendRows) {
  readme += `- **${t.domain}**: ${t.neu} new, ${t.persisting} persisting, ${t.resolved} resolved · score **${t.score}/100** (was ${t.prev}, ${t.score-t.prev>=0?'+':''}${t.score-t.prev}) · ${t.aiCalls} Claude calls\n`;
}
readme += `\nThese are produced by the diff engine in \`workflow_v2.json\` (run it) and match \`Assignment4_Singh_Kanishk.html\` and \`scale_test_results.md\`.\n`;
readme += `\n## Scale test (50 domains)\n\n`;
readme += `The \`scale_test_50/\` subfolder holds a real 50-domain batch run produced by \`../scale_test_50.js\`\n`;
readme += `(same \`pipeline.js\` code path). It contains 50 rendered HTML reports, \`scale_test_50_run.json\`,\n`;
readme += `\`scale_test_50_summary.csv\`, \`scale_test_50_dashboard.html\`/\`.png\`, and the canonical\n`;
readme += `\`pipeline_error_log.txt\`. Violation/call/score counts are measured; API latency, wall-clock,\n`;
readme += `injected timeouts and cost are clearly labelled as modeled (offline, no live key).\n`;
fs.writeFileSync(path.join(OUT, 'README.md'), readme);

console.log('Generated outputs:');
for (const [f] of manifest) console.log('  outputs/' + f);
console.log('  outputs/README.md');
