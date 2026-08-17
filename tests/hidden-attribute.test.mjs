// Guards against a bug this codebase has now shipped twice.
//
// The `hidden` attribute is ONLY a user-agent stylesheet `display: none`.
// Any author rule that sets `display` on the same element silently defeats
// it, so `el.hidden = true` renders the element anyway. It has bitten:
//
//   1. .header-btn / .header-user / .mobile-sheet-add-band (display:inline-flex,
//      display:flex) -- signed-out header affordances stayed on screen.
//   2. .node-card__edit (display:inline-flex) -- the "Edit this band" pencil
//      stayed visible and clickable while signed out, and clicking it did
//      nothing, because renderEditAffordances() had correctly set .hidden.
//
// Both times the JavaScript was right and the CSS quietly overrode it, which
// is the worst possible failure mode: nothing throws, no test fails, and the
// bug is only visible to someone looking at the page in the wrong auth state.
//
// This test reads index.html and reports every element that is markup-hidden
// (carries a literal `hidden` attribute, i.e. its visibility is meant to be
// toggled) whose id or class also has an author rule setting `display` to
// something other than `none`, unless a `[hidden]` guard rule exists for it.
//
// If this test fails, the fix is a guard rule, not a workaround:
//   .your-class[hidden] { display: none !important; }

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');

/** All <style> blocks concatenated, with comments stripped. */
function styleText(html) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flat list of { selector, body } for every top-level rule. Selector lists are
 * split on commas so each selector is checked on its own. At-rules (@media
 * etc.) are descended into, since a display rule inside @media defeats
 * `hidden` exactly as well as one outside it.
 */
function cssRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) {
    const rawSelector = match[1].trim();
    const body = match[2];
    // An at-rule preamble picked up as a "selector" has no declarations of its
    // own; its inner rules are matched separately by the same regex pass.
    if (rawSelector.startsWith('@')) continue;
    rawSelector.split(',').forEach(sel => {
      const selector = sel.replace(/\s+/g, ' ').trim();
      if (selector) rules.push({ selector, body });
    });
  }
  return rules;
}

function declaredDisplay(body) {
  const matches = [...body.matchAll(/(?:^|;)\s*display\s*:\s*([^;!]+)/g)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim().toLowerCase();
}

/** Elements carrying a literal `hidden` attribute in the markup. */
function markupHiddenElements(html) {
  const body = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  const out = [];
  for (const match of body.matchAll(/<([a-z][a-z0-9-]*)\s([^>]*?)\/?>/gi)) {
    const attrs = match[2];
    // `hidden` as a bare boolean attribute, not e.g. aria-hidden or data-hidden.
    if (!/(?:^|\s)hidden(?=[\s/>=]|$)/.test(attrs)) continue;
    const id = (attrs.match(/\sid\s*=\s*"([^"]*)"/) || [])[1] || null;
    const classes = ((attrs.match(/\sclass\s*=\s*"([^"]*)"/) || [])[1] || '')
      .split(/\s+/).filter(Boolean);
    out.push({ tag: match[1], id, classes, snippet: match[0].slice(0, 100) });
  }
  return out;
}

const CSS = styleText(HTML);
const RULES = cssRules(CSS);
const HIDDEN_ELEMENTS = markupHiddenElements(HTML);

test('the parser finds the page CSS and its hideable elements', () => {
  // Cheap self-check: if index.html is restructured such that these come back
  // empty, the tests below would vacuously pass and stop protecting anything.
  assert.ok(RULES.length > 200, `expected to parse many CSS rules, got ${RULES.length}`);
  assert.ok(HIDDEN_ELEMENTS.length > 5, `expected several markup-hidden elements, got ${HIDDEN_ELEMENTS.length}`);
});

test('no markup-hidden element has its display overridden without a [hidden] guard', () => {
  // Tokens (#id or .class) that some rule already guards with [hidden].
  const guarded = new Set();
  let blanketGuard = false;
  RULES.forEach(({ selector, body }) => {
    if (!selector.includes('[hidden]')) return;
    if (declaredDisplay(body) !== 'none') return;
    if (selector === '[hidden]') { blanketGuard = true; return; }
    const token = selector.match(/^([.#][A-Za-z0-9_-]+)\[hidden\]$/);
    if (token) guarded.add(token[1]);
  });

  // Tokens that have an author display rule (other than display:none).
  const overridden = new Map();
  RULES.forEach(({ selector, body }) => {
    if (selector.includes('[hidden]')) return;
    const display = declaredDisplay(body);
    if (!display || display === 'none') return;
    // Only simple, whole-element selectors: `.class`, `#id`, and those with
    // pseudo-classes. A descendant/compound selector may legitimately set
    // display in a narrower context, and flagging those would be noise.
    const token = selector.match(/^([.#][A-Za-z0-9_-]+)(?:::?[a-z-]+(?:\([^)]*\))?)?$/);
    if (!token) return;
    if (!overridden.has(token[1])) overridden.set(token[1], { display, selector });
  });

  const offenders = [];
  HIDDEN_ELEMENTS.forEach(el => {
    if (blanketGuard) return;
    const tokens = [...(el.id ? [`#${el.id}`] : []), ...el.classes.map(c => `.${c}`)];
    tokens.forEach(token => {
      if (guarded.has(token)) return;
      const hit = overridden.get(token);
      if (!hit) return;
      offenders.push(
        `${el.tag}${el.id ? `#${el.id}` : ''} is markup-hidden, but \`${hit.selector} { display: ${hit.display} }\` `
        + `defeats the hidden attribute. Add: ${token}[hidden] { display: none !important; }`,
      );
    });
  });

  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});
