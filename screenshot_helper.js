// Helper for the screenshot pipeline. Chrome (via CLI) can't read ~/Downloads
// due to macOS TCC, but node (here) can. So node stages HTML into /tmp and
// later copies the rendered PNGs back into outputs/screenshots.
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const STAGE = '/tmp/a11yshots';
const SHOTS = path.join(BASE, 'outputs', 'screenshots');

const FILES = [
  ['outputs/accessibility_report_example.com_2026-05-23_flagship.html', 'report_example_flagship.html'],
  ['outputs/accessibility_report_example.com_2026-05-23.html',          'report_example.html'],
  ['outputs/accessibility_report_shopmart.io_2026-05-30.html',          'report_shopmart.html'],
  ['outputs/accessibility_report_techblog.dev_2026-05-30.html',         'report_techblog.html'],
  ['outputs/email_digest_example.com_2026-05-23.html',                  'email_example.html'],
  ['outputs/email_digest_shopmart.io_2026-05-30.html',                  'email_shopmart.html'],
  ['outputs/compliance_trends_dashboard.html',                          'trends_dashboard.html'],
  ['before_after_comparison.html',                                      'before_after.html'],
];

const mode = process.argv[2];

if (mode === 'stage') {
  fs.mkdirSync(STAGE, { recursive: true });
  for (const [src, dst] of FILES) {
    fs.copyFileSync(path.join(BASE, src), path.join(STAGE, dst));
  }
  console.log('staged ' + FILES.length + ' files to ' + STAGE);
} else if (mode === 'collect') {
  fs.mkdirSync(SHOTS, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(STAGE)) {
    if (f.endsWith('.png')) {
      fs.copyFileSync(path.join(STAGE, f), path.join(SHOTS, f));
      n++;
    }
  }
  console.log('collected ' + n + ' PNGs to ' + SHOTS);
} else {
  console.error('usage: node screenshot_helper.js stage|collect');
  process.exit(1);
}
