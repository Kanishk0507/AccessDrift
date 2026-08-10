/**
 * livefix.js — concrete, actionable fix suggestions for LIVE scans without an
 * ANTHROPIC_API_KEY. Replaces pipeline.js's generic "refer to the documentation"
 * fallback with real before/after guidance per axe-core rule, enriched with the
 * specifics axe itself reports (actual contrast ratios, colors, failure summary).
 *
 * Each entry returns { plain_english, impact_statement, code_fix, estimated_time, risk_level }.
 */

const A11Y = '~15% of users rely on assistive technology';

// Per-rule remediation. `v` is the captured violation (has selector, html_snippet,
// failure_summary, fix_data, page_url, etc.).
const KB = {
  'image-alt': v => ({
    plain_english: 'This image has no text alternative, so screen-reader users get nothing where sighted users see the image.',
    impact_statement: 'Affects blind and low-vision users relying on screen readers.',
    code_fix: `Add an alt attribute describing the image's purpose.\nOLD: ${snip(v) || '<img src="…">'}\nNEW: <img src="…" alt="Short description of what the image shows">\nIf the image is purely decorative, use alt="" so screen readers skip it.`,
    estimated_time: '2-5 minutes', risk_level: 'Low'
  }),
  'color-contrast': v => {
    const d = v.fix_data || {};
    const have = d.contrastRatio != null ? `${d.contrastRatio}:1` : 'too low';
    const need = d.expectedContrastRatio || '4.5:1 (3:1 for large text ≥ 24px, or ≥ 18.66px bold)';
    const colors = d.fgColor && d.bgColor ? ` Foreground ${d.fgColor} on background ${d.bgColor}.` : '';
    return {
      plain_english: `The text on this element is too low-contrast against its background (currently ${have}), so it's hard to read.${colors}`,
      impact_statement: 'Affects low-vision users and ~8% of users with color-vision deficiency.',
      code_fix: `Increase the contrast to at least ${need}. Darken the text colour or lighten/darken the background until it passes.${d.fgColor ? ` e.g. replace the foreground ${d.fgColor} with a darker shade.` : ''} Verify with a contrast checker (WebAIM / browser devtools).`,
      estimated_time: '2-5 minutes', risk_level: 'Low'
    };
  },
  'link-name': v => ({
    plain_english: 'This link has no discernible text, so a screen reader announces just "link" with no idea where it goes.',
    impact_statement: 'Affects screen-reader and voice-control users navigating by links.',
    code_fix: `Give the link real text or an accessible name.\nOLD: ${snip(v) || '<a href="/x"><svg/></a>'}\nNEW: <a href="/x">Descriptive link text</a>  —  or keep the icon and add aria-label="Descriptive link text". If an inner <img> is the only content, give it alt text instead.`,
    estimated_time: '3 minutes', risk_level: 'Low'
  }),
  'link-in-text-block': v => ({
    plain_english: 'This link sits inside a block of text but is only distinguished by colour, so colour-blind users can\'t tell it\'s a link.',
    impact_statement: 'Affects users with colour-vision deficiency.',
    code_fix: 'Make links in body text distinguishable by more than colour: add an underline (CSS `text-decoration: underline`) on the link, or ensure it has at least a 3:1 contrast ratio against the surrounding text AND a non-colour cue on hover/focus.',
    estimated_time: '5 minutes', risk_level: 'Low'
  }),
  'button-name': v => ({
    plain_english: 'This button has no accessible name, so assistive tech announces it as just "button" with no purpose.',
    impact_statement: 'Affects screen-reader and voice-control users.',
    code_fix: `Add an accessible name.\nOLD: ${snip(v) || '<button><svg/></button>'}\nNEW: <button aria-label="What the button does">…</button>  —  or put visible text inside the button. If the inner icon is decorative, add aria-hidden="true" to it.`,
    estimated_time: '2 minutes', risk_level: 'Low'
  }),
  'input-button-name': v => KB['button-name'](v),
  'label': v => ({
    plain_english: 'This form field has no associated label, so screen-reader users don\'t know what to type.',
    impact_statement: 'Affects screen-reader and voice-control users filling the form.',
    code_fix: `Tie a real <label> to the input via matching for/id.\nOLD: ${snip(v) || '<input id="email" placeholder="Email">'}\nNEW: <label for="email">Email address</label> <input id="email">  —  a visible label is preferred over aria-label because it also helps voice-control and cognitive-load users.`,
    estimated_time: '3 minutes', risk_level: 'Low'
  }),
  'select-name': v => KB['label'](v),
  'html-has-lang': v => ({
    plain_english: 'The page\'s <html> element has no lang attribute, so screen readers can\'t pick the right pronunciation rules.',
    impact_statement: 'Affects screen-reader users across the whole page.',
    code_fix: 'Add a valid language to the root element: <html lang="en"> (use the correct BCP-47 code for the page\'s language, e.g. "es", "fr-CA").',
    estimated_time: '1 minute', risk_level: 'Low'
  }),
  'html-lang-valid': v => ({
    plain_english: 'The <html lang="…"> value isn\'t a valid BCP-47 language code, so screen readers may ignore it.',
    impact_statement: 'Affects screen-reader users.',
    code_fix: 'Use a valid code with a hyphen, not an underscore: <html lang="fr-CA"> (not "fr_CA").',
    estimated_time: '1 minute', risk_level: 'Low'
  }),
  'document-title': v => ({
    plain_english: 'The page has no <title>, so screen-reader users and browser tabs have nothing to identify it by.',
    impact_statement: 'Affects screen-reader users orienting between pages/tabs.',
    code_fix: 'Add a descriptive <title> in the <head>: <title>Page name — Site name</title>.',
    estimated_time: '2 minutes', risk_level: 'Low'
  }),
  'heading-order': v => ({
    plain_english: 'Heading levels are out of order (a level is skipped), which breaks the outline screen-reader users navigate by.',
    impact_statement: 'Affects screen-reader users navigating by headings.',
    code_fix: 'Make heading levels increase by one — don\'t jump from <h2> to <h4>. Change the skipped heading to the next sequential level (e.g. <h4> → <h3>). Style with CSS if you need a different visual size.',
    estimated_time: '3 minutes', risk_level: 'Low'
  }),
  'list': v => ({
    plain_english: 'A <ul>/<ol> contains elements other than <li> (or list items aren\'t wrapped in a list), breaking list semantics.',
    impact_statement: 'Affects screen-reader users who rely on "list with N items" announcements.',
    code_fix: 'Ensure <ul>/<ol> contain only <li> children (plus optional <script>/<template>). Move any wrapper <div>s inside the <li>, or change the container if it isn\'t really a list.',
    estimated_time: '5 minutes', risk_level: 'Low'
  }),
  'listitem': v => ({
    plain_english: 'An <li> is not contained in a <ul> or <ol>, so it loses its list semantics.',
    impact_statement: 'Affects screen-reader users.',
    code_fix: 'Wrap the <li> in a parent <ul> or <ol>, or use a different element if it isn\'t a list item.',
    estimated_time: '3 minutes', risk_level: 'Low'
  }),
  'region': v => ({
    plain_english: 'This content sits outside any landmark region, so screen-reader users can\'t jump to it via landmark navigation.',
    impact_statement: 'Affects screen-reader users navigating by regions.',
    code_fix: 'Wrap page content in semantic landmarks: <header>, <nav>, <main>, <footer>, or add role attributes. Put the primary content inside a single <main>.',
    estimated_time: '5-10 minutes', risk_level: 'Low'
  }),
  'landmark-one-main': v => ({
    plain_english: 'The page has no <main> landmark (or more than one), so "skip to main content" and landmark navigation don\'t work.',
    impact_statement: 'Affects screen-reader and keyboard users.',
    code_fix: 'Wrap the primary content in exactly one <main>…</main> element.',
    estimated_time: '3 minutes', risk_level: 'Low'
  }),
  'target-size': v => ({
    plain_english: 'This interactive control is smaller than the 24×24 px minimum touch target, making it hard to tap accurately.',
    impact_statement: 'Affects users with motor impairments and touch-screen users.',
    code_fix: 'Increase the control to at least 24×24 CSS px (44×44 is better) via padding or min-width/min-height, or add enough spacing so targets don\'t overlap.',
    estimated_time: '5 minutes', risk_level: 'Low'
  }),
  'duplicate-id': v => ({
    plain_english: 'An id value is used more than once on the page; ARIA references and labels can then point to the wrong element.',
    impact_statement: 'Affects screen-reader users when the duplicated id is referenced.',
    code_fix: 'Make every id unique. Rename the duplicate and update any for=, aria-labelledby, or aria-describedby that referenced it.',
    estimated_time: '3 minutes', risk_level: 'Low'
  }),
  'aria-required-attr': v => ({
    plain_english: 'An element with an ARIA role is missing a required ARIA attribute for that role, so its state isn\'t conveyed.',
    impact_statement: 'Affects screen-reader users.',
    code_fix: `Add the required ARIA attribute(s) for this role. ${v.failure_summary ? 'axe reports: ' + v.failure_summary : 'Check the role\'s required states/properties.'}`,
    estimated_time: '5 minutes', risk_level: 'Low'
  }),
  'frame-title': v => ({
    plain_english: 'This <iframe> has no title, so screen-reader users can\'t tell what it contains.',
    impact_statement: 'Affects screen-reader users.',
    code_fix: 'Add a descriptive title: <iframe title="What this frame contains" …>.',
    estimated_time: '2 minutes', risk_level: 'Low'
  }),
  'svg-img-alt': v => ({
    plain_english: 'This <svg> with an image role has no accessible name.',
    impact_statement: 'Affects screen-reader users.',
    code_fix: 'Give the SVG a name: add a <title> as the first child, or role="img" plus aria-label="Description". If decorative, add aria-hidden="true".',
    estimated_time: '2 minutes', risk_level: 'Low'
  })
};

function snip(v) {
  return v.html_snippet ? v.html_snippet.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

/* Specific fallback for rules not in the KB: use axe's own failure summary
 * (which is concrete — it names the actual problem) plus the help URL. */
function fromAxe(v) {
  const summary = v.failure_summary
    ? v.failure_summary.replace(/^Fix (any|all) of the following:\s*/i, '').trim()
    : '';
  return {
    plain_english: v.description || `A ${v.impact} "${v.rule_id}" issue was detected.`,
    impact_statement: `May affect assistive-technology users (${A11Y}).`,
    code_fix: (summary ? `What to fix: ${summary}` : `Resolve the "${v.rule_id}" issue on this element.`)
      + (v.help_url ? `\nReference: ${v.help_url}` : ''),
    estimated_time: '5-15 minutes', risk_level: 'Low'
  };
}

function localFix(v) {
  const make = KB[v.rule_id];
  return make ? make(v) : fromAxe(v);
}

module.exports = { localFix };
