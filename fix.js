#!/usr/bin/env node
/**
 * CLI for "Fix" mode:  node fix.js <path-to.html>
 * Scans a local HTML file, applies the safe deterministic accessibility fixes
 * (with Claude-generated labels when ANTHROPIC_API_KEY is set), writes
 * <name>.fixed.html, and prints the before/after score.
 */
const { fixFile } = require('./src/autofix');

const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m` };

(async () => {
  const input = process.argv[2];
  if (!input) { console.error('usage: node fix.js <path-to.html>'); process.exit(1); }

  console.log(C.b(`\n🔧 Accessibility Fix — ${input}`));
  console.log(C.d(`   labels: ${process.env.ANTHROPIC_API_KEY ? 'Claude (ANTHROPIC_API_KEY set)' : 'derived (set ANTHROPIC_API_KEY for meaningful text)'}\n`));
  const r = await fixFile(input);

  const arrow = r.after.score >= r.before.score ? C.g('▲') : C.r('▼');
  console.log(`  Score:      ${C.b(r.before.score)}  →  ${C.b(C.g(r.after.score))}  ${arrow} ${C.g('+' + (r.after.score - r.before.score))}`);
  console.log(`  Violations: ${r.before.count}  →  ${r.after.count}  (${C.g(r.before.count - r.after.count + ' fixed')})\n`);

  if (r.applied.length) {
    console.log(C.b('  ✅ Applied automatically:'));
    for (const a of r.applied) console.log(`     • ${C.g(a.rule)}${a.ai ? C.c(' ✦') : ''} — ${a.change}`);
    console.log(C.d(`     ✦ = meaningful text from Claude\n`));
  }
  if (r.skipped.length) {
    console.log(C.b('  ⚠️  Left for human review (not safe to auto-fix):'));
    for (const s of r.skipped) console.log(`     • ${C.y(s.rule)} [${s.impact}] — ${s.help}  ${C.d(s.selector)}`);
    console.log();
  }
  console.log(`  📄 Wrote: ${C.b(r.outPath)}\n`);
})().catch(e => { console.error(C.r('Error: ' + e.message)); process.exit(1); });
