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
const scriptCollect = readFileSync(join(root, 'extension', 'collect-report.js'), 'utf8');
const scriptReport = readFileSync(join(root, 'extension', 'report.js'), 'utf8');
const reportHtml = readFileSync(join(root, 'extension', 'report.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const appHtml = readFileSync(join(root, 'app', 'Main.html'), 'utf8');
const fastfile = readFileSync(join(root, 'fastlane', 'Fastfile'), 'utf8');
// The page is one self-contained file; pull its inline script out for checks
// that need the JS on its own.
const appScript = (appHtml.match(/<script>([\s\S]*?)<\/script>/i) || [, ''])[1];

// Count literal occurrences without building a RegExp out of file contents —
// dynamic patterns from file data are a code-scanning finding (js/regex-injection),
// and plain string counting is what these checks actually need.
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

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

test('manifest is MV3 with the two nag scripts plus the report collector', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts?.length, 3);
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

test('X script removes the blocking "See this post in the app" modal by its data-interaction marker', () => {
  assert.ok(
    scriptX.includes('[data-interaction^="app-store-obstruction"]'),
    'must match X\'s own semantic marker for the blocking app-install modal',
  );
  // The modal covers the viewport with `touch-none`, so hiding it IS the scroll
  // fix — but it must also be in the CSS backstop, which for this one needs no
  // :has() and therefore works below iOS 16.4 too.
  assert.ok(
    /style\.textContent =[\s\S]*?\$\{APP_OBSTRUCTION_SELECTOR\}\s*\{\s*display: none/.test(scriptX),
    'the injected CSS must hide the blocking modal as well',
  );
});

test('X script never matches modals by role/aria alone (must not catch legitimate X dialogs)', () => {
  // Comments discuss these selectors on purpose; only real code counts.
  const codeX = scriptX.replace(/^\s*\/\/.*$/gm, '');
  for (const overbroad of ['role="dialog"', 'aria-modal', 'touch-none']) {
    assert.ok(
      !codeX.includes(overbroad),
      `must not select on ${overbroad} — X uses the same shape for the share menu, ` +
        'the verified-badge popover and other legitimate dialogs',
    );
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

test('injectStyle() never throws when there is no document element yet', () => {
  // At document_start there may be nothing to append to. A throw there escapes
  // the first run() call and aborts the script BEFORE the MutationObserver is
  // installed, so the page silently gets no protection at all.
  for (const [name, src] of [['reddit', script], ['x', scriptX]]) {
    const injectStyle = new Function(
      'document',
      `${src.match(/function injectStyle\(\) \{[\s\S]*?\n  \}/)[0]}; return injectStyle;`,
    )({ head: null, documentElement: null, getElementById: () => null });
    assert.doesNotThrow(injectStyle, `${name} script: injectStyle() must bail out, not throw`);
  }
});

// ── Bug reporter (popup + collector) ──────────────────────────────────────
// The reporter is the only part of the extension that produces something a
// user sends somewhere, so the guards here are mostly about what it must NOT
// do: never upload anything itself, never modify the page it is describing.

// report.js keeps its pure formatting helpers above the "Popup wiring" marker
// precisely so they can be driven here without a DOM. Sliced on the marker
// rather than matched per-function: no regex built from file contents.
function loadReportHelpers() {
  const marker = '// ── Popup wiring';
  const pure = scriptReport.slice(0, scriptReport.indexOf(marker));
  assert.ok(scriptReport.includes(marker), 'report.js must keep the pure/wiring split');
  return new Function(
    `${pure}\nreturn { truncate, buildBody, issueUrl, fitIssue, defaultTitle, describeSnapshot };`,
  )();
}

test('the report popup is wired into the manifest and ships its files', () => {
  assert.equal(manifest.action?.default_popup, 'report.html');
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.ok(reportHtml.trim() && scriptReport.trim(), 'popup page and script must be non-empty');
});

test('the collector runs on the same hosts as the nag scripts and only reads the page', () => {
  const cs = manifest.content_scripts.find((entry) => entry.js?.includes('collect-report.js'));
  assert.ok(cs, 'collector content script entry missing');
  assert.deepEqual(cs.matches, ['*://*.reddit.com/*', '*://*.x.com/*', '*://*.twitter.com/*']);
  // Not document_start: it has nothing to race, and the snapshot is most useful
  // once the page (and our own nag removal) has settled.
  assert.equal(cs.run_at, 'document_idle');

  // A diagnostics reader must never mutate the page it is diagnosing — a bug
  // here would break browsing on every visit, not just when reporting.
  const code = scriptCollect.replace(/^\s*\/\/.*$/gm, '');
  for (const mutation of ['.remove()', 'setAttribute', 'classList', 'appendChild', 'innerHTML =']) {
    assert.ok(!code.includes(mutation), `collector must not mutate the page (found ${mutation})`);
  }
});

test('reporter scripts are syntactically valid', () => {
  assert.doesNotThrow(() => new Function(scriptCollect));
  assert.doesNotThrow(() => new Function(scriptReport));
});

test('the popup page keeps its JS in a separate file and loads nothing remote', () => {
  // MV3's default CSP (script-src 'self') blocks inline <script> on extension
  // pages, so — unlike app/Main.html — this page MUST reference report.js.
  assert.ok(/<script src="report\.js"><\/script>/.test(reportHtml), 'popup must load report.js');
  assert.ok(
    !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(reportHtml),
    'inline <script> is blocked by the extension CSP — the popup would silently do nothing',
  );
  assert.ok(!/https?:\/\//.test(reportHtml), 'popup page must not reference a remote URL');
});

test('the reporter never uploads anything by itself', () => {
  // The whole design: compose text, hand it to github.com's own new-issue form,
  // let the user read it and press Submit. No token, no endpoint, no POST.
  const code = scriptReport.replace(/^\s*\/\/.*$/gm, '');
  for (const upload of ['XMLHttpRequest', 'POST', 'navigator.sendBeacon', 'Authorization']) {
    assert.ok(!code.includes(upload), `the reporter must not transmit reports itself (found ${upload})`);
  }
  // The only network-shaped call is reading our own packaged build-info.json.
  assert.equal((code.match(/\bfetch\(/g) || []).length, 1, 'exactly one fetch, for a packaged file');
  assert.ok(code.includes("fetch(api.runtime.getURL('build-info.json'))"));
  const urls = code.match(/https?:\/\/[^\s'"`)]+/g) || [];
  assert.deepEqual(urls, ['https://github.com/${REPO}/issues/new'], 'the only remote URL is the issue form');
  assert.ok(code.includes("const REPO = 'ssalonen/keep-scrolling'"), 'issues must go to this repo');
});

test('the prefilled issue URL is trimmed to fit GitHub, cutting page HTML before the user text', () => {
  const { buildBody, fitIssue } = loadReportHelpers();
  const parts = {
    description: 'The sheet came back after 30 seconds and the page froze.',
    environment: { 'Keep Scrolling': '1.2.3 (45)', Page: 'https://www.reddit.com/r/a/comments/b/c/' },
    pageState: '{"scrollable": false}',
    html: `<html>${'<div class="rpl-bottom-sheet">x</div>'.repeat(8000)}</html>`,
  };

  const fitted = fitIssue('Nag not removed on reddit.com', parts, 6000);
  assert.ok(fitted.url.length <= 6000, `URL still ${fitted.url.length} chars — GitHub answers 414`);
  assert.ok(fitted.truncated, 'must report that the page HTML was cut, so the popup offers the full copy');
  assert.ok(fitted.body.includes(parts.description), 'the user’s own words must survive the trim');
  assert.ok(fitted.body.includes('1.2.3 (45)'), 'the version must survive the trim');

  // A small report goes through untouched.
  const small = fitIssue('t', { ...parts, html: '<html>small</html>' }, 6000);
  assert.equal(small.truncated, false);
  assert.ok(small.body.includes('<html>small</html>'));

  // Even an over-long description alone still produces a filable URL.
  const wordy = fitIssue('t', { ...parts, description: 'x'.repeat(50000), html: '' }, 6000);
  assert.ok(wordy.url.length <= 6000, `URL still ${wordy.url.length} chars`);

  // Page HTML is opt-out: dropping it must drop the whole section.
  assert.ok(!buildBody({ ...parts, html: '' }).includes('<details>'));
});

test('the report names the build it came from and the state of the page', () => {
  const { describeSnapshot, defaultTitle } = loadReportHelpers();
  const { environment, pageState } = describeSnapshot(
    {
      url: 'https://x.com/i/status/1',
      userAgent: 'Mozilla/5.0 (iPhone)',
      viewport: '390x844 @3x',
      scriptsActive: { reddit: false, x: true },
      lock: { scrollable: false },
      signatures: [{ selector: '[data-interaction^="app-store-obstruction"]', count: 1 }],
    },
    { version: '1.2.3', build: '45' },
  );
  assert.equal(environment['Keep Scrolling'], '1.2.3 (45)');
  assert.equal(environment['Content script ran'], 'x');
  assert.equal(environment['Page scrollable'], 'false');
  assert.ok(pageState.includes('app-store-obstruction'));
  assert.equal(defaultTitle('https://www.reddit.com/r/a/'), 'Nag not removed on reddit.com');
});

test('the captured HTML is stripped of scripts, styles and credential-shaped values', () => {
  const source = scriptCollect.match(/function sanitizeHtml\(html\) \{[\s\S]*?\n  \}/);
  assert.ok(source, 'sanitizeHtml() not found in collect-report.js');
  const sanitizeHtml = new Function(`${source[0]}; return sanitizeHtml;`)();

  for (const [markup, secret] of [
    ['<script>var t = "s3cret";</script>', 's3cret'],
    ['<style>body { background: url(s3cret) }</style>', 's3cret'],
    ['<meta name="csrf-token" content="s3cret">', 's3cret'],
    ['<div data-session-token="s3cret"></div>', 's3cret'],
    ['<input type="password" value="s3cret">', 's3cret'],
    ['<textarea>s3cret</textarea>', 's3cret'],
    [`<img src="data:image/png;base64,${'s3cret'.repeat(20)}">`, 's3cret'],
  ]) {
    assert.ok(!sanitizeHtml(markup).includes(secret), `sanitizeHtml left ${secret} in: ${markup}`);
  }

  // …while keeping the markup that a nag report is actually about.
  const nag = '<rpl-bottom-sheet blocking open id="app-upsell-blocking-bottom-sheet-seo"></rpl-bottom-sheet>';
  assert.equal(sanitizeHtml(nag), nag);
});

test('the collector reports whether the nag scripts ran at all', () => {
  // An empty signature list means nothing if we cannot tell "clean page" from
  // "extension never ran"; the injected marker stylesheets are that signal.
  for (const marker of ['rnr-style', 'xnr-style']) {
    assert.ok(scriptCollect.includes(marker), `missing content-script marker: ${marker}`);
    assert.ok(
      script.includes(marker) || scriptX.includes(marker),
      `${marker} is not injected by either nag script — the report would always say "did not run"`,
    );
  }
});

test('build-info.json is stamped at build time and verified in the IPA', () => {
  const info = JSON.parse(readFileSync(join(root, 'extension', 'build-info.json'), 'utf8'));
  assert.ok(info.version && info.build, 'placeholder version/build must exist for unstamped builds');
  assert.ok(scriptReport.includes("getURL('build-info.json')"), 'the popup must read the stamped version');

  assert.ok(/def apply_build_info/.test(fastfile), 'apply_build_info must exist');
  assert.ok(
    /^\s*apply_build_info\(marketing_version, build_number\)$/m.test(fastfile),
    'apply_build_info must actually be called from generate_project',
  );
  assert.ok(
    fastfile.includes(`grep -q '"version": "#{marketing_version}"'`),
    'verify_ipa must prove the shipped build-info.json carries this release’s version',
  );

  // Everything the popup needs must be listed for the IPA check, or a missing
  // file only shows up as a blank sheet on device.
  const listed = fastfile.match(/REPORT_FILES = \[(.*?)\]/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(listed.sort(), ['collect-report.js', 'report.html', 'report.js']);
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
  assert.ok(appScript.trim(), 'Main.html must carry its host glue in an inline <script>');
  assert.doesNotThrow(() => new Function(appScript), 'the inline script must be syntactically valid');
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
  assert.ok(!/https?:\/\//.test(appHtml), 'Main.html must not reference a remote URL');
});

test('app UI is one self-contained file with no sibling assets', () => {
  // The converter localizes Main.html into Base.lproj/ while plain resources
  // land at the .app root, so a relative reference to a sibling file does not
  // resolve at runtime — and the template ships no Script.js to overwrite.
  // Both facts broke a release; inline everything instead.
  for (const [, ref] of appHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(ref.startsWith('data:'), `app UI must inline its assets, got a reference to: ${ref}`);
  }
  assert.ok(!/<link\b/i.test(appHtml), 'no external stylesheet — the CSS is inline');
  assert.ok(!/<script[^>]+\bsrc=/i.test(appHtml), 'no external script — the JS is inline');
  assert.ok(/<style>/i.test(appHtml) && /<script>/i.test(appHtml), 'CSS and JS must be inline in the page');
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
  // apply_app_ui overwrites the template's filename in place; a file listed
  // here but absent from app/ (or vice versa) fails the build on a Mac only,
  // long after CI went green.
  const listed = fastfile.match(/APP_UI_FILES = \[(.*?)\]/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(listed, ['Main.html'], 'the page is one self-contained file — see the Fastfile comment');

  const token = fastfile.match(/APP_UI_VERSION_TOKEN = "([^"]+)"/)[1];
  assert.equal(
    countOccurrences(appHtml, token),
    1,
    `${token} must appear EXACTLY once (the footer). apply_app_ui gsubs every occurrence, so a ` +
      'second one — e.g. inside the inline script — gets rewritten too and silently changes behaviour',
  );
  // The script's "was it substituted?" guard therefore keys on the shape of the
  // replacement, not on the token.
  const replacement = fastfile.match(/gsub\(APP_UI_VERSION_TOKEN, "([^"#]*)/)[1];
  assert.ok(replacement.startsWith('Version '), 'the substituted footer text must start with "Version "');
  assert.ok(
    /\/\^Version\\s\//.test(appScript),
    'the inline script must detect an unsubstituted footer by shape (/^Version\\s/), not by the token',
  );

  const marker = fastfile.match(/APP_UI_MARKER = '([^']+)'/)[1];
  assert.ok(appHtml.includes(marker), `verify_ipa greps the shipped Main.html for ${marker}`);
});

test('app UI scrolls its own content, and the Fastfile re-enables the web view scroll', () => {
  // Two independent layers, because the page is taller than a phone screen and
  // the converter's host template disables the web view's scroll view on iOS.
  assert.ok(
    /main\s*\{[^}]*overflow-y:\s*auto/.test(appHtml),
    'main must be an overflow:auto scroll container — it scrolls inside WebKit even when the ' +
      "host disabled the web view's own scroll view",
  );
  assert.ok(
    fastfile.includes('isScrollEnabled = false') && fastfile.includes('isScrollEnabled = true'),
    'generate_project must flip the template\'s webView.scrollView.isScrollEnabled back on',
  );
  assert.ok(
    /def enable_app_scrolling/.test(fastfile) && /enable_app_scrolling\s*$/m.test(fastfile),
    'enable_app_scrolling must be defined and actually called from generate_project',
  );
});

test('app UI keeps the enable instructions, the one thing a user must act on', () => {
  assert.ok(/Extensions/.test(appHtml), 'must tell the user where Safari lists extensions');
  assert.ok(/Allow Always/.test(appHtml), 'must mention Allow Always — otherwise Safari prompts every visit');
  for (const cls of ['platform-ios-only', 'platform-mac-only']) {
    // Once in the markup, once in the inline CSS that hides/shows it.
    assert.ok(countOccurrences(appHtml, cls) >= 2, `missing platform switching for ${cls}`);
  }
});
