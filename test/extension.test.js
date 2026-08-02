// Lightweight guards for the content script + manifest. No dependencies —
// run with `node --test`. These lock in the invariants from CLAUDE.md so a
// careless edit can't silently regress the two things that must both happen:
// remove the blocking sheet AND release the body scroll-lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(join(root, 'extension', 'block-reddit-nag.js'), 'utf8');
const scriptX = readFileSync(join(root, 'extension', 'block-x-nag.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));

test('content script is syntactically valid', () => {
  // Throws on a syntax error; `new Function` never executes the body.
  assert.doesNotThrow(() => new Function(script));
});

test('matches the nag by STABLE structural signatures (not rotating IDs)', () => {
  for (const sig of [
    'rpl-bottom-sheet[blocking]',
    '[id*="app-upsell-blocking"]',
    'faceplate-loader[name^="AppUpsellBlocking"]',
  ]) {
    assert.ok(script.includes(sig), `missing stable signature: ${sig}`);
  }
});

test('releases the body scroll-lock classes', () => {
  for (const cls of ['rpl-scroll-lock', 'scroll-is-blocked']) {
    assert.ok(script.includes(cls), `missing scroll-lock class handling: ${cls}`);
  }
  assert.ok(/function\s+releaseScroll/.test(script), 'releaseScroll() must exist');
  assert.ok(/function\s+killNags/.test(script), 'killNags() must exist');
});

test('neutralizes the ::part overlay/panel fog and stays reactive', () => {
  assert.ok(script.includes('::part(overlay)'), 'must neutralize overlay fog');
  assert.ok(script.includes('MutationObserver'), 'must self-heal via MutationObserver');
});

test('does not over-block faceplate-loader beyond AppUpsellBlocking', () => {
  // Every faceplate-loader mention must be the prefix-scoped selector — no
  // bare `faceplate-loader` that would nuke legitimate lazy-loaded content.
  const total = (script.match(/faceplate-loader/g) || []).length;
  const scoped = (script.match(/faceplate-loader\[name\^="AppUpsellBlocking"\]/g) || []).length;
  assert.ok(total > 0, 'expected the AppUpsellBlocking loader selector');
  assert.equal(scoped, total, 'all faceplate-loader selectors must be AppUpsellBlocking-scoped');
});

function findContentScript(matchPattern) {
  return manifest.content_scripts?.find((cs) => cs.matches?.includes(matchPattern));
}

test('manifest is MV3 with exactly two content scripts', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts?.length, 2);
});

test('Reddit content script is scoped to reddit.com at document_start', () => {
  const cs = findContentScript('*://*.reddit.com/*');
  assert.ok(cs, 'reddit content script entry missing');
  assert.deepEqual(cs.matches, ['*://*.reddit.com/*']);
  assert.deepEqual(cs.js, ['block-reddit-nag.js']);
  assert.equal(cs.run_at, 'document_start');
});

test('X content script is scoped to x.com and twitter.com at document_start', () => {
  const cs = findContentScript('*://*.x.com/*');
  assert.ok(cs, 'X content script entry missing');
  assert.deepEqual(cs.matches, ['*://*.x.com/*', '*://*.twitter.com/*']);
  assert.deepEqual(cs.js, ['block-x-nag.js']);
  assert.equal(cs.run_at, 'document_start');
});

test('X content script is syntactically valid', () => {
  assert.doesNotThrow(() => new Function(scriptX));
});

test('X script matches the app-upsell banner by its purpose-built href/download marker', () => {
  for (const sig of ['download', 'launch_app_store=true', "closest('aside')"]) {
    assert.ok(scriptX.includes(sig), `missing marker: ${sig}`);
  }
});

test('X script only removes the whole <aside> when it is actually the fixed floating banner', () => {
  assert.ok(
    scriptX.includes('getComputedStyle(aside).position === \'fixed\''),
    'must gate whole-<aside> removal on position:fixed — an in-flow <aside> could be unrelated ' +
      'content (e.g. a reply-list region) whose removal would break the page beyond the banner',
  );
});

test('X script never matches on <aside> or role=region alone (must not catch cookie-consent banner)', () => {
  assert.ok(
    !/document\.querySelectorAll\(\s*['"]aside['"]\s*\)/.test(scriptX),
    'must not query bare <aside> — would catch the unrelated cookie-consent banner',
  );
  assert.ok(
    !/querySelectorAll\([^)]*role=/.test(scriptX),
    'must not select on role=region — would catch the unrelated cookie-consent banner',
  );
});

test('stripAppStoreParam removes only the launch_app_store=true flag, preserving the rest of the query string', () => {
  const match = scriptX.match(/function stripAppStoreParam\(url\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'stripAppStoreParam function not found in source');
  const stripAppStoreParam = new Function(`${match[0]}; return stripAppStoreParam;`)();
  assert.equal(
    stripAppStoreParam('https://m.x.com/i/status/1?launch_app_store=true&ct=engagement_reply'),
    'https://m.x.com/i/status/1?ct=engagement_reply',
  );
  assert.equal(
    stripAppStoreParam('https://m.x.com/i/status/1?launch_app_store=true'),
    'https://m.x.com/i/status/1',
  );
  assert.equal(
    stripAppStoreParam('https://m.x.com/i/status/1?ct=engagement_reply&launch_app_store=true'),
    'https://m.x.com/i/status/1?ct=engagement_reply',
  );
});

test('X script defuses launch_app_store=true on both href and data-href (engagement buttons and whole-row tap targets)', () => {
  assert.ok(scriptX.includes('function defuseAppStoreLinks'), 'defuseAppStoreLinks() must exist');
  for (const sig of ['[href*="launch_app_store=true"]', '[data-href*="launch_app_store=true"]']) {
    assert.ok(scriptX.includes(sig), `missing selector: ${sig}`);
  }
  assert.ok(
    /run\(\)\s*\{[\s\S]*?defuseAppStoreLinks\(\);/.test(scriptX),
    'defuseAppStoreLinks() must run on every pass alongside killNags()',
  );
});

test('X script removes the "See this post in the app" obstruction dialog by its data-interaction marker', () => {
  assert.ok(
    scriptX.includes('[data-interaction^="app-store-obstruction"]'),
    'must match the obstruction dialog by X\'s own purpose-built data-interaction name',
  );
});

test('X script never matches role=dialog or aria-modal alone (must not catch legitimate modals)', () => {
  // Attribute-selector form only ever appears in a selector, never in prose.
  for (const sig of ['[role="dialog"]', '[aria-modal']) {
    assert.ok(
      !scriptX.includes(sig),
      `must not select on ${sig} — legitimate X UI (menus, share sheets) uses it too`,
    );
  }
  // Every data-interaction selector must be app-store-obstruction-scoped —
  // the attribute also tags legitimate controls (e.g. mobile-top-bar-log-in).
  const total = (scriptX.match(/\[data-interaction/g) || []).length;
  const scoped = (scriptX.match(/\[data-interaction\^="app-store-obstruction"\]/g) || []).length;
  assert.ok(total > 0, 'expected the app-store-obstruction selector');
  assert.equal(scoped, total, 'all data-interaction selectors must be app-store-obstruction-scoped');
});

test('X script releases scroll only when the banner is found', () => {
  assert.ok(/function\s+releaseScroll/.test(scriptX), 'releaseScroll() must exist');
  assert.ok(/function\s+killNags/.test(scriptX), 'killNags() must exist');
  assert.ok(
    /if\s*\(\s*hit\s*\)\s*releaseScroll\(\)/.test(scriptX),
    'releaseScroll() must be gated on hit, unlike the unconditional Reddit release',
  );
});

test('X script stays reactive via MutationObserver', () => {
  assert.ok(scriptX.includes('MutationObserver'));
});

test('manifest icons exist on disk', () => {
  for (const [, file] of Object.entries(manifest.icons || {})) {
    assert.doesNotThrow(
      () => readFileSync(join(root, 'extension', file)),
      `icon file missing: ${file}`,
    );
  }
});
