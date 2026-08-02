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
const appHtml = readFileSync(join(root, 'app', 'Main.html'), 'utf8');
const appCss = readFileSync(join(root, 'app', 'Style.css'), 'utf8');
const appScript = readFileSync(join(root, 'app', 'Script.js'), 'utf8');
const fastfile = readFileSync(join(root, 'fastlane', 'Fastfile'), 'utf8');

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

// ── Container app UI (app/) ───────────────────────────────────────────────
// The generated Xcode project is a build artifact, so these guard the only
// tracked half of the container app: the page itself, and the contract it has
// with the Fastfile that copies it and the Swift host that drives it.

test('app UI keeps the template contract the Swift host calls into', () => {
  assert.doesNotThrow(() => new Function(appScript), 'Script.js must be syntactically valid');
  assert.ok(
    /function show\(platform, enabled, useSettingsInsteadOfPreferences\)/.test(appScript),
    'the ViewController calls a global show(platform, enabled, useSettingsInsteadOfPreferences)',
  );
  assert.ok(
    appScript.includes("webkit.messageHandlers.controller.postMessage('open-preferences')"),
    'the macOS host answers the "open-preferences" message — keep the exact string',
  );
});

test('app UI loads nothing from the network (offline WKWebView + the privacy claim it makes)', () => {
  for (const [name, source] of [['Main.html', appHtml], ['Style.css', appCss], ['Script.js', appScript]]) {
    assert.ok(!/https?:\/\//.test(source), `${name} must not reference a remote URL`);
  }
  // Every referenced asset is a bare filename bundled next to the page.
  for (const [, ref] of appHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!ref.includes('/'), `app UI asset must be a sibling file, got: ${ref}`);
  }
});

test('app UI overview names every site the extension actually runs on', () => {
  // Keeps the feature blurb honest if a third site is ever added to the manifest.
  const hosts = new Set(
    manifest.content_scripts.flatMap((cs) => cs.matches).map((m) => m.replace(/^\*:\/\/\*\.|\/\*$/g, '')),
  );
  for (const host of hosts) {
    assert.ok(appHtml.includes(host), `app overview does not mention ${host}`);
  }
  assert.ok(/Reddit/.test(appHtml) && /\bX\b/.test(appHtml), 'overview must name both Reddit and X');
});

test('app UI matches what the Fastfile copies and verify_ipa greps for', () => {
  // apply_app_ui overwrites the template's filenames in place; a file listed
  // here but absent from app/ (or vice versa) fails the build on a Mac only,
  // long after CI went green.
  const listed = fastfile.match(/APP_UI_FILES = \[(.*?)\]/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(listed, ['Main.html', 'Style.css', 'Script.js']);

  const token = fastfile.match(/APP_UI_VERSION_TOKEN = "([^"]+)"/)[1];
  assert.ok(appHtml.includes(token), `Main.html must contain ${token} for the version substitution`);
  assert.ok(appScript.includes(token), 'Script.js must drop the footer if the token survived into a build');

  const marker = fastfile.match(/APP_UI_MARKER = '([^']+)'/)[1];
  assert.ok(appHtml.includes(marker), `verify_ipa greps the shipped Main.html for ${marker}`);
});

test('app UI keeps the enable instructions, the one thing a user must act on', () => {
  assert.ok(/Extensions/.test(appHtml), 'must tell the user where Safari lists extensions');
  assert.ok(/Allow Always/.test(appHtml), 'must mention Allow Always — otherwise Safari prompts every visit');
  for (const cls of ['platform-ios-only', 'platform-mac-only']) {
    assert.ok(appHtml.includes(cls) && appCss.includes(cls), `missing platform switching for ${cls}`);
  }
});
