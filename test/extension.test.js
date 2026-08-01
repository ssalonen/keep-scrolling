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
