// Lightweight guards for the content script + manifest. No dependencies —
// run with `node --test`. These lock in the invariants from CLAUDE.md so a
// careless edit can't silently regress the two things that must both happen:
// remove the blocking sheet AND release the body scroll-lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
const scrollHarness = readFileSync(join(root, 'test', 'scroll', 'harness.mjs'), 'utf8');
const scrollRunner = readFileSync(join(root, 'test', 'scroll', 'run.mjs'), 'utf8');
const scrollMirror = readFileSync(join(root, 'test', 'scroll', 'mirror.mjs'), 'utf8');
const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const security = readFileSync(join(root, '.github', 'workflows', 'security.yml'), 'utf8');
const scrollWebkit = readFileSync(join(root, 'test', 'scroll', 'webkit.mjs'), 'utf8');
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
// The page is one self-contained file; pull its inline script out for checks
// that need the JS on its own.
const appScript = (appHtml.match(/<script>([\s\S]*?)<\/script>/i) || [, ''])[1];

// Count literal occurrences without building a RegExp out of file contents —
// dynamic patterns from file data are a code-scanning finding (js/regex-injection),
// and plain string counting is what these checks actually need.
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

// A stand-in for what the paste host hands back, kept in one place so the
// assertions about it never spell a URL out inside a substring test.
const PASTE_LINK = 'https://paste.rs/AbC12';

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

test('X script matches the app-upsell nag by its purpose-built href marker', () => {
  for (const sig of ['launch_app_store=true', "closest('aside')"]) {
    assert.ok(scriptX.includes(sig), `missing marker: ${sig}`);
  }
  // X dropped the `download` attribute from every app-store link; a selector
  // that still required it matched nothing at all on the shipped page.
  assert.ok(
    !/a\[download\]/.test(scriptX),
    'must not require the `download` attribute — X no longer emits it, so the selector ' +
      'silently stopped matching the banner and the top-bar "Open app" pill',
  );
});

test('X script tells nag links from engagement controls by X\'s own ct= surface name', () => {
  const match = scriptX.match(/function isNagLink\(url\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'isNagLink() not found in source');
  const isNagLink = new Function(`${match[0]}; return isNagLink;`)();

  // Standalone "get the app" affordances — hide these.
  assert.ok(isNagLink('https://m.x.com/u/status/1?launch_app_store=true&ct=post-modal'));
  assert.ok(isNagLink('https://m.x.com/u/status/1?launch_app_store=true&ct=post-timeline'));
  assert.ok(isNagLink('https://m.x.com/u/status/1?launch_app_store=true'), 'top-bar pill has no ct');

  // Controls the reader deliberately tapped — never hide these; they are
  // defused by stripping the param instead.
  for (const ct of ['engagement_reply', 'engagement_retweet', 'engagement_like',
    'engagement_bookmark', 'engagement_view_post', 'engagement_generic']) {
    assert.ok(
      !isNagLink(`https://m.x.com/i/status/1?launch_app_store=true&ct=${ct}`),
      `must never hide the ${ct} control`,
    );
  }
});

test('X script hides nags instead of removing them (X server-renders them; React hydrates)', () => {
  // Removing a server-rendered node at document_start is a structural
  // hydration mismatch: the reply list came back as permanent "Loading post"
  // skeletons, which reads to a user as "the page will not scroll".
  assert.ok(scriptX.includes('data-xnr-hidden'), 'must mark hidden nags with data-xnr-hidden');
  assert.ok(
    scriptX.includes("HIDDEN_SELECTOR = '[data-xnr-hidden]'"),
    'HIDDEN_SELECTOR must be the mark hideNags() sets',
  );
  assert.ok(
    /style\.textContent =[\s\S]*?\$\{HIDDEN_SELECTOR\}\s*\{\s*display: none !important; \}/.test(scriptX),
    'the injected CSS must hide whatever was marked',
  );
  const codeX = scriptX.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/\.remove\(\)/.test(codeX),
    'must not remove nodes from X\'s DOM — hide them, so React\'s tree stays intact',
  );
});

test('X script only hides the whole <aside> when it is actually the fixed floating banner', () => {
  assert.ok(
    scriptX.includes('getComputedStyle(aside).position === \'fixed\''),
    'must gate whole-<aside> hiding on position:fixed — an in-flow <aside> could be unrelated ' +
      'content (e.g. a reply-list region) whose removal would break the page beyond the banner',
  );
});

test('X script hides the blocking "See this post in the app" modal by its data-interaction marker', () => {
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
    'defuseAppStoreLinks() must run on every pass alongside hideNags()',
  );
  // Ordering matters now that nags are hidden rather than removed: the param
  // defuseAppStoreLinks() strips is the marker hideNags() matches on, so a
  // freshly rendered nag has to be seen before it is defused.
  assert.ok(
    /run\(\)\s*\{[\s\S]*?hideNags\(\);[\s\S]*?defuseAppStoreLinks\(\);/.test(scriptX),
    'hideNags() must run before defuseAppStoreLinks() — it strips the marker hideNags() needs',
  );
});

test('X script releases scroll on every pass, not only when a nag was matched', () => {
  assert.ok(/function\s+releaseScroll/.test(scriptX), 'releaseScroll() must exist');
  assert.ok(/function\s+hideNags/.test(scriptX), 'hideNags() must exist');
  // The release used to be gated on `hit`. X locks the page from prompts that
  // carry none of our markers, so the gate never opened and the page stayed
  // frozen with nothing on screen to explain it.
  assert.ok(
    !/if\s*\(\s*hit\s*\)\s*releaseScroll\(\)/.test(scriptX),
    'releaseScroll() must not be gated on hit — a lock we cannot attribute to a recognised nag ' +
      'is exactly the case that leaves the page frozen',
  );
  assert.ok(
    /releaseScroll\(\);\s*\n\s*return hit;/.test(scriptX),
    'hideNags() must re-assert scroll unconditionally, matching the Reddit script',
  );
});

test('X script undoes Base UI\'s scroll lock, not just the overflow half of it', () => {
  // X moved its logged-out prompts from `vaul` onto Base UI. Its lock has two
  // shapes: inline overflow-x/overflow-y:hidden (mobile Safari, where there is
  // no scrollbar to compensate for), and — marked with its own
  // data-base-ui-scroll-locked on <html> — moving the scroll onto <body> as a
  // position:relative, 100dvh/100vw, border-box box with the offset parked in
  // body.scrollTop. Clearing overflow alone leaves that body clamped to one
  // viewport: released, and still unscrollable.
  const match = scriptX.match(/function releaseBaseUiLock\(\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'releaseBaseUiLock() not found in source');
  const fn = match[0];
  assert.ok(
    scriptX.includes('data-base-ui-scroll-locked'),
    "must key on Base UI's own lock marker, not on the shape of the styles",
  );
  for (const prop of ['position', 'height', 'width', 'box-sizing']) {
    assert.ok(fn.includes(`'${prop}'`), `must clear the whole locked-body set (missing ${prop})`);
  }
  assert.ok(
    /window\.scrollTo\(0,\s*offset\)/.test(fn),
    'must restore the offset Base UI parked in body.scrollTop',
  );
  assert.ok(
    /const offset = body \? body\.scrollTop : 0;[\s\S]*?removeProperty/.test(fn),
    'must read body.scrollTop back BEFORE clearing the styles that make body scrollable',
  );
  assert.ok(
    /releaseScroll\(\) \{\s*(?:\/\/[^\n]*\n\s*)*releaseBaseUiLock\(\);/.test(scriptX),
    'releaseBaseUiLock() must run first, for the same reason',
  );

  const releaseScroll = scriptX.match(/function releaseScroll\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(
    releaseScroll.includes("s.overflowX === 'hidden'"),
    "must clear Base UI's mobile lock on both axes",
  );
});

test('X script undoes the position:fixed body lock and restores the scroll offset', () => {
  // The `vaul` drawer library X now ships locks the page with
  // position:fixed !important + a negative `top` holding the scroll offset,
  // not with overflow:hidden. Clearing `position` without reading `top` back
  // releases the scroll but teleports the reader to the top of the thread.
  const match = scriptX.match(/function releaseScroll\(\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'releaseScroll() not found in source');
  const body = match[0];
  assert.ok(body.includes("s.position === 'fixed'"), 'must detect the position:fixed lock');
  assert.ok(/removeProperty\(prop\)/.test(body), 'must clear the whole pinned-position set');
  assert.ok(/window\.scrollTo\(0,\s*-offset\)/.test(body), 'must restore the stashed scroll offset');
  assert.ok(
    body.includes("s.overflow === 'hidden'"),
    'must still handle the original inline overflow:hidden lock',
  );
});

test('X script only ever clears INLINE lock styles', () => {
  // A stylesheet-driven overflow rule is the page's own layout; touching it
  // would be fighting X's design rather than its nag.
  const body = scriptX.match(/function releaseScroll\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(
    !/getComputedStyle/.test(body),
    'releaseScroll() must read el.style (inline) only, never computed styles',
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
    `${pure}\nreturn { truncate, buildBody, issueUrl, fitIssue, fitClipboard, trimMiddle,
      defaultTitle, describeSnapshot, SYMPTOMS, URL_BUDGET, BODY_BUDGET };`,
  )();
}

// The collector's helpers are plain functions over globals, so each can be
// driven on its own with a stub document — no DOM implementation needed.
function loadCollectorFunction(name, globals) {
  const source = {
    collectOverlays: scriptCollect.match(/function collectOverlays\(\) \{[\s\S]*?\n  \}/),
    collectComponents: scriptCollect.match(/function collectComponents\(\) \{[\s\S]*?\n  \}/),
  }[name];
  assert.ok(source, `${name}() not found in collect-report.js`);
  // Shared helpers the extracted function calls; they close over the stubbed
  // sanitizeHtml/truncate/TAG_LIMIT passed in as globals.
  const helpers = scriptCollect.match(/function openingTag\(el\) \{[\s\S]*?\n  \}/);
  assert.ok(helpers, 'openingTag() not found in collect-report.js');
  const names = Object.keys(globals);
  return new Function(...names, `${helpers[0]}; ${source[0]}; return ${name};`)(
    ...names.map((k) => globals[k]),
  );
}

test('the report popup is wired into the manifest and ships its files', () => {
  assert.equal(manifest.action?.default_popup, 'report.html');
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.ok(reportHtml.trim() && scriptReport.trim(), 'popup page and script must be non-empty');
});

test('the uploaded snapshot is trimmed to the host’s byte ceiling, and linked as plain text', () => {
  // Two measured properties of the paste host this code must respect:
  //  - over 393 216 bytes it answers 206 and stores a copy cut from the FRONT,
  //    which is the one cut that loses a late-injected nag. So trim first, by
  //    BYTES: a page snapshot is not ASCII and a character count overshoots.
  //  - `<id>.html` makes it RENDER the captured page. The link must stay
  //    extension-less so the snapshot is served as text.
  const source = scriptReport.match(/function trimToBytes\(html, maxBytes\) \{[\s\S]*?\n\}/);
  assert.ok(source, 'trimToBytes() not found in report.js');
  const trimMiddleSource = scriptReport.match(/function trimMiddle\(html, keep\) \{[\s\S]*?\n\}/)[0];
  const trimToBytes = new Function(
    'HTML_HEAD_SHARE',
    `${trimMiddleSource}\n${source[0]}\nreturn trimToBytes;`,
  )(0.25);

  const multibyte = `<html>${'☃'.repeat(200000)}<div id="nag"></div></html>`;
  assert.ok(new TextEncoder().encode(multibyte).length > 393216, 'fixture must exceed the ceiling');
  const trimmed = trimToBytes(multibyte, 393216);
  assert.ok(
    new TextEncoder().encode(trimmed).length <= 393216,
    'must measure BYTES — a char-count trim overshoots on multibyte content and gets a 206',
  );
  assert.ok(trimmed.endsWith('<div id="nag"></div></html>'), 'the end of the document must survive');
  assert.equal(trimToBytes('<html>tiny</html>', 393216), '<html>tiny</html>', 'small pages untouched');

  assert.equal(scriptReport.match(/const UPLOAD_MAX_BYTES = (\d+)/)[1], '393216');
  assert.ok(
    scriptReport.includes("path.lastIndexOf('.')") && scriptReport.includes('path.slice(0, dot)'),
    'the returned URL must have any extension stripped — .html would render the captured page',
  );
  // …and stripped without a trailing-quantifier regex: run over a network
  // response, that is quadratic in the input (js/polynomial-redos).
  assert.ok(
    !/\+\$\/[a-z]*\s*,/.test(scriptReport.slice(scriptReport.indexOf('async function uploadSnapshot'))),
    'no `+$` regex may be applied to the upload response',
  );
  assert.ok(
    /parsed\.origin\}\/` !== SNAPSHOT_ENDPOINT/.test(scriptReport),
    'the response URL must be validated by parsing and comparing ORIGIN, not by a substring test',
  );
  assert.ok(
    /const PASTE_PATH = \/\^/.test(scriptReport) && /\$\/;/.test(scriptReport),
    'the paste-path pattern must be anchored at both ends',
  );
  assert.ok(
    /response\.status === 206/.test(scriptReport),
    '206 means the host truncated the paste — the issue must say so',
  );
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
  // Two side effects are allowed, both user-initiated from the popup and
  // neither touching the DOM: the scroll test (which restores the position it
  // started from) and the baseline reload. Nothing else may reach the page.
  assert.ok(
    /location\.reload/.test(code) && /pause-once/.test(code),
    'the baseline reload is the only navigation the collector may cause',
  );
});

test('reporter scripts are syntactically valid', () => {
  assert.doesNotThrow(() => new Function(scriptCollect));
  assert.doesNotThrow(() => new Function(scriptReport));
});

test('the X script releases the lock when a finger lands, not only on mutations', () => {
  // Paired captures of one post showed X escalating when the banner is hidden:
  // without the extension it renders the <aside> banner and the page scrolls;
  // with it there is no banner and a touch-none app-store-obstruction modal
  // instead. So the lock we race is the aggressive one, and a mutation-driven
  // pass can be a frame late. Releasing on touchstart closes the window from
  // the other end.
  assert.ok(/addEventListener\('touchstart'|'touchstart',/.test(scriptX)
    || /\['touchstart', 'pointerdown'\]/.test(scriptX), 'must release on touchstart');
  assert.ok(
    /passive: true/.test(scriptX),
    'the listener must be passive — it must never be able to delay or cancel a scroll',
  );
});

test('the collector measures the scroll instead of asking the reader to describe it', () => {
  // Three reports in a row said "the page will not scroll" and arrived with
  // every collected field saying the page was fine. The reader was right each
  // time; a snapshot is a state and this is a behaviour.
  assert.ok(/function scrollTest/.test(scriptCollect), 'scrollTest() must exist');
  assert.ok(/function verdictFor/.test(scriptCollect),
    'the report must say what the numbers mean, not leave them to be interpreted');
  // It must put the page back: a diagnostic that leaves the reader somewhere
  // else in the thread is its own bug report.
  assert.ok(
    /window\.scrollTo\(0, started\)/.test(scriptCollect),
    'the scroll test must restore the original position',
  );
  // A programmatic scroll sails past touch-action, so the verdict has to lean
  // on the pan probe for exactly that case.
  assert.ok(/pan && pan\.blocked/.test(scriptCollect),
    'the verdict must account for a cover that only a finger would hit');
  assert.ok(/scrollTest: snapshot\.scrollTest/.test(scriptReport),
    'the measurement must reach the issue body');
  assert.ok(/id="scroll-test"/.test(reportHtml), 'the popup needs the button');
});

test('the extension annotates its own edits so a snapshot separates them', () => {
  // A report is a snapshot taken AFTER the scripts ran, so without markers
  // there is no way to tell our edits from the site's markup — which is why
  // telling them apart took a second, extension-off capture and a whole
  // debugging session.
  assert.ok(/data-xnr-defused/.test(scriptX),
    'a rewritten link must record what it was before');
  assert.ok(
    /if \(!el\.hasAttribute\(DEFUSED_ATTR\)\)/.test(scriptX),
    'only the first rewrite is the original — a later pass must not overwrite it',
  );
  assert.ok(/function noteRelease/.test(scriptX), 'lock releases must be counted');
  assert.ok(/data-xnr-releases/.test(scriptX) && /data-xnr-last-lock/.test(scriptX),
    'the tally must be readable from the page');
  assert.ok(/function describeEdits/.test(scriptCollect), 'the report must carry the tally');
  assert.ok(/edits: snapshot\.edits/.test(scriptReport), 'the issue body must carry it too');
});

test('a one-shot pause lets the reader capture the same page untouched', () => {
  // The paired capture is what showed X escalating from banner to blocking
  // modal. Getting it must not require a trip to Settings.
  for (const [name, src] of [['reddit', script], ['x', scriptX]]) {
    assert.ok(
      /sessionStorage\.getItem\('keep-scrolling:pause-once'\)/.test(src),
      `${name} script must honour the pause flag`,
    );
    assert.ok(
      /removeItem\('keep-scrolling:pause-once'\)/.test(src),
      `${name} script must clear the flag immediately — a stuck flag would `
        + 'silently disable the extension',
    );
  }
  assert.ok(/id="baseline"/.test(reportHtml), 'the popup needs the button');
});

test('the collector can tell a flickering lock from no lock at all', () => {
  // A lock applied and released repeatedly reads identically to a healthy page
  // in a single sample, which is how three reports in a row arrived with every
  // field saying the page was fine.
  assert.ok(/function watchLock/.test(scriptCollect), 'watchLock() must exist');
  assert.ok(/LOCK_SAMPLES/.test(scriptCollect) && /LOCK_GAP_MS/.test(scriptCollect),
    'sampling must be over a window, not one reading');
  assert.ok(/lockStates: snapshot\.lock\.states/.test(scriptReport),
    'the issue body must carry how many distinct lock states were seen');
});

test('the collector reports whether a finger can pan, not just whether the document is tall', () => {
  // Issue #25: a full-screen touch-action:none cover froze the page while
  // `scrollable` (document height vs viewport) said true, overflow was visible
  // and neither html nor body carried a lock. Every field read "healthy".
  const match = scriptCollect.match(/function forbidsVerticalPan\(touchAction\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'forbidsVerticalPan() not found in source');
  const forbidsVerticalPan = new Function(`${match[0]}; return forbidsVerticalPan;`)();

  for (const value of ['none', 'pan-x', 'pan-left', 'pan-x pinch-zoom']) {
    assert.equal(forbidsVerticalPan(value), true, `${value} forbids a vertical pan`);
  }
  for (const value of ['auto', 'manipulation', 'pan-y', 'pan-y pinch-zoom', 'pan-down', undefined]) {
    assert.equal(forbidsVerticalPan(value), false, `${value} allows a vertical pan`);
  }

  assert.ok(
    /pan: describeTouchTarget\(\)/.test(scriptCollect),
    'describeScrollLock() must carry the pan probe',
  );
  assert.ok(
    /pan: snapshot\.lock\.pan/.test(scriptReport),
    'the issue body must carry the pan probe — it is the field that would have named issue #25',
  );
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

test('the reporter sends to exactly one endpoint, and never submits the issue itself', () => {
  // The reporter now uploads the page snapshot — a GitHub issue body caps at
  // 65 536 characters and cannot hold one. That is a deliberate reversal of the
  // old "nothing is ever uploaded" rule, so these guards pin down what it may
  // do rather than forbidding it outright: ONE known endpoint, no credentials,
  // no back-channel, and the issue still submitted by the user by hand.
  const code = scriptReport.replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['XMLHttpRequest', 'navigator.sendBeacon', 'Authorization', 'credentials:']) {
    assert.ok(!code.includes(banned), `the reporter must not grow a back-channel (found ${banned})`);
  }

  // Two fetches, both accounted for: the packaged build info, and the upload.
  assert.equal((code.match(/\bfetch\(/g) || []).length, 2, 'exactly two fetches');
  assert.ok(code.includes("fetch(api.runtime.getURL('build-info.json'))"), 'one reads a packaged file');
  assert.ok(/fetch\(SNAPSHOT_ENDPOINT, \{/.test(code), 'the other is the snapshot upload');

  // Exactly one POST, to the named constant — never to github.com, which would
  // mean filing the issue on the user's behalf without them reading it.
  assert.equal((code.match(/method: 'POST'/g) || []).length, 1, 'exactly one POST');
  const urls = [...new Set(code.match(/https?:\/\/[^\s'"`)]+/g) || [])].sort();
  assert.deepEqual(
    urls,
    ['https://github.com/${REPO}/issues/new', 'https://paste.rs/', 'https://paste.rs/*'],
    'the only remote URLs are the issue form, the snapshot host, and its permissions match pattern',
  );
  assert.ok(code.includes("const REPO = 'ssalonen/keep-scrolling'"), 'issues must go to this repo');
  assert.ok(
    code.includes("const SNAPSHOT_ENDPOINT = 'https://paste.rs/'"),
    'the upload target must be a single named constant, not built at runtime',
  );
});

test('the upload host is declared in the manifest and matches the endpoint', () => {
  // Without host_permissions the popup cannot read the response: the host
  // sends no Access-Control-Allow-Origin and answers OPTIONS with 404.
  assert.deepEqual(manifest.host_permissions, ['https://paste.rs/']);
  assert.deepEqual(manifest.permissions, ['activeTab'], 'no permission creep beyond the upload host');
  const endpoint = scriptReport.match(/const SNAPSHOT_ENDPOINT = '([^']+)'/)[1];
  assert.ok(
    manifest.host_permissions.includes(endpoint),
    'the declared host and the endpoint the code posts to must not drift apart',
  );
});

test('the upload is opt-in, previewed, and degrades to the clipboard when it fails', () => {
  // The upload is the one thing that leaves the device, so it may only happen
  // from the file button, with a box the user can untick, and it must never
  // cost the report when the host rate-limits or is down.
  assert.ok(/id="upload-html"/.test(reportHtml), 'the popup needs the upload opt-out');
  // Plain string, not a host-shaped regex: an unanchored /paste\.rs/ reads as
  // a hostname check that can be bypassed, which is a code-scanning finding
  // even in a test — and `includes` is what this actually means.
  assert.ok(reportHtml.includes('paste.rs'), 'the checkbox must name the service it uploads to');
  assert.ok(
    /const willUpload = \(\) =>[\s\S]*?uploadHtml\.checked/.test(scriptReport),
    'uploading must be gated on the checkbox',
  );
  assert.ok(
    scriptReport.includes("outcome = 'attempted but failed") && scriptReport.includes('Upload failed'),
    'a failed upload must fall back, not throw away the report',
  );

  // Safari does not grant host permissions at install, and its popup is
  // dismissed the moment the resulting prompt takes focus — which is how a
  // report arrived with no snapshot link on device. The grant has to be
  // askable on its own button, before the filing flow depends on it.
  assert.ok(/id="allow-upload"/.test(reportHtml), 'the popup needs a standalone Allow control');
  assert.ok(
    scriptReport.includes('async function requestUploadPermission')
      && scriptReport.includes("permission === 'missing'"),
    'the popup must ask for the paste.rs grant explicitly rather than letting the fetch raise it',
  );
  assert.ok(
    scriptReport.includes('uploadOutcome: outcome'),
    'the issue must record WHY there is no link — declined, not allowed, or failed',
  );
  // The preview is the consent step: it must say the snapshot will be sent.
  assert.ok(
    scriptReport.includes('htmlPending'),
    'the preview must show a pending-upload line in place of the snapshot',
  );
});

test('the container app tells the truth about what leaves the device', () => {
  // app/Main.html is the only screen a user sees, and it used to promise that
  // nothing is ever uploaded. If the reporter uploads, that page must say so.
  const claimsAbsolutePrivacy = /<h3>Nothing leaves your device<\/h3>/.test(appHtml);
  assert.ok(!claimsAbsolutePrivacy, 'the unqualified claim is no longer true — qualify it');
  assert.ok(appHtml.includes('paste.rs'), 'the privacy card must name the upload service');
  assert.ok(/bug/i.test(appHtml), 'and must tie the upload to filing a bug report');
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
  assert.ok(fitted.body.includes('{"scrollable": false}'), 'the page state must survive the trim');

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

test('an over-budget page HTML block is dropped WHOLE, with a note pointing at the clipboard copy', () => {
  // A snapshot cut to fit is the top of <head> — link tags and meta, never the
  // nag, which sits deep in <body>. It would spend the whole budget and still
  // be undiagnosable, so the block goes entirely and the clipboard carries it.
  const { fitIssue } = loadReportHelpers();
  const parts = {
    description: 'Overlay covered everything.',
    environment: { 'Keep Scrolling': '1.2.3 (45)' },
    pageState: '{"scrollable": false}',
    html: `<html><head>${'<link rel="modulepreload" href="/a.js">'.repeat(4000)}</head></html>`,
  };

  const fitted = fitIssue('t', parts, 6000);
  assert.ok(fitted.url.length <= 6000, `URL still ${fitted.url.length} chars`);
  assert.ok(!fitted.body.includes('<details>'), 'no half a snapshot — the whole block goes');
  assert.ok(!fitted.body.includes('modulepreload'), 'no page-HTML fragment may survive in the URL');
  assert.ok(
    /paste it here/i.test(fitted.body),
    'the issue must say the HTML is on the clipboard and where to paste it — otherwise it reads ' +
      'as a complete report that merely lacks a snapshot',
  );

  // The note is only for a report that HAD page HTML; opting out is not a
  // pending paste.
  const optedOut = fitIssue('t', { ...parts, html: '' }, 6000);
  assert.ok(!/paste it here/i.test(optedOut.body), 'no paste note when the user opted out of the HTML');
});

test('sections are dropped in order: page HTML, then diagnostics, then page state', () => {
  const { fitIssue } = loadReportHelpers();
  const base = {
    description: 'x',
    environment: { 'Keep Scrolling': '1.2.3 (45)' },
    pageState: '{"lock": "small"}',
    diagnostics: `{"overlays": "${'d'.repeat(400)}"}`,
    html: `<html>${'p'.repeat(1500)}</html>`,
  };
  // Measured section costs for this report, as prefilled-URL length:
  // everything 2459, without the HTML 807, without the diagnostics too 304.

  // A budget that fits everything but the HTML: the diagnostics stay.
  const roomy = fitIssue('t', base, 1000);
  assert.ok(!roomy.body.includes('<html>'), 'the HTML goes first');
  assert.ok(roomy.body.includes('overlays'), 'diagnostics outlive the HTML');
  assert.ok(roomy.body.includes('"lock": "small"'), 'page state outlives the diagnostics');
  assert.ok(roomy.url.length <= 1000, `URL still ${roomy.url.length} chars`);

  // Tighter: the diagnostics go too, the lock state stays.
  const tight = fitIssue('t', base, 500);
  assert.ok(!tight.body.includes('overlays'), 'diagnostics go before the page state');
  assert.ok(tight.body.includes('"lock": "small"'), 'the lock state is the last structured part to go');
  assert.ok(tight.url.length <= 500, `URL still ${tight.url.length} chars`);
});

test('the popup offers the common symptoms as a multi-select folded into title and body', () => {
  const { SYMPTOMS, buildBody, defaultTitle } = loadReportHelpers();

  // The three things the two nag scripts actually fail at, plus an escape hatch.
  assert.deepEqual(SYMPTOMS.map((s) => s.id), ['nag', 'scroll', 'overlay', 'other']);
  for (const symptom of SYMPTOMS) {
    assert.ok(symptom.label && symptom.title, `symptom ${symptom.id} needs both a label and a title`);
  }

  const chosen = [SYMPTOMS[1], SYMPTOMS[2]];
  const body = buildBody({ symptoms: chosen, environment: {}, description: '' });
  for (const symptom of chosen) {
    assert.ok(body.includes(`- ${symptom.label}`), `body must list the ticked symptom: ${symptom.label}`);
  }
  assert.ok(
    !body.includes('_No description provided._'),
    'ticked symptoms ARE the description — do not also claim there is none',
  );

  // The title follows the first ticked symptom, so a frozen page does not
  // arrive titled "nag not removed".
  assert.equal(defaultTitle('https://x.com/i/status/1', chosen), 'Page will not scroll on x.com');
  assert.equal(defaultTitle('https://www.reddit.com/r/a/'), 'Nag not removed on reddit.com');

  // Rendered from SYMPTOMS at runtime: the label a user taps and the line the
  // issue gets must be one string, not two that drift apart.
  assert.ok(/id="symptoms"/.test(reportHtml), 'popup needs the symptom container');
  assert.ok(scriptReport.includes('function renderSymptoms'), 'the checkboxes are built from SYMPTOMS');
  for (const symptom of SYMPTOMS) {
    assert.ok(!reportHtml.includes(symptom.label), `symptom label duplicated into report.html: ${symptom.label}`);
  }
});

test('the report names the build it came from and the state of the page', () => {
  const { describeSnapshot, defaultTitle } = loadReportHelpers();
  const { environment, pageState, diagnostics, samples } = describeSnapshot(
    {
      url: 'https://x.com/i/status/1',
      userAgent: 'Mozilla/5.0 (iPhone)',
      viewport: '390x844 @3x',
      scriptsActive: { reddit: false, x: true },
      lock: {
        scrollable: false,
        elements: [
          { element: 'html', present: true, class: '', style: '', computed: { overflow: 'visible' } },
          { element: 'body', present: true, class: '', style: 'position: fixed', computed: { position: 'fixed' } },
        ],
      },
      signatures: [{
        selector: '[data-interaction^="app-store-obstruction"]',
        count: 1,
        sample: '<div data-interaction="app-store-obstruction"></div>',
      }],
      overlays: [{ coverage: 1, tag: '<div data-vaul-drawer="">' }],
      components: ['bottom-prompt', 'vaul'],
    },
    { version: '1.2.3', build: '45' },
  );
  assert.equal(environment['Keep Scrolling'], '1.2.3 (45)');
  assert.equal(environment['Content script ran'], 'x');
  assert.equal(environment['Page scrollable'], 'false');
  assert.ok(pageState.includes('app-store-obstruction'));
  assert.equal(defaultTitle('https://www.reddit.com/r/a/'), 'Nag not removed on reddit.com');

  // Split into three so the URL trim can drop the bulky parts and keep the
  // parts that always matter, smallest first. The lock and a selector→count
  // tally stay in pageState; what is covering the page is in diagnostics; the
  // sampled markup — a subset of the page HTML the clipboard carries anyway —
  // is on its own in samples, where it is dropped first.
  assert.ok(pageState.includes('"scrollable": false'), 'the lock state stays in the smallest block');
  assert.ok(pageState.includes('"position": "fixed"'), 'the lock is flattened, not nested in "elements"');
  assert.ok(!pageState.includes('"elements"'), 'the collector’s wrapper keys are not worth URL budget');
  assert.ok(!pageState.includes('<div data-interaction'), 'samples do not belong in the kept block');

  assert.ok(diagnostics.includes('data-vaul-drawer'), 'unrecognised overlays must reach the issue');
  assert.ok(diagnostics.includes('bottom-prompt'), 'preloaded component names must reach the issue');
  assert.ok(!diagnostics.includes('<div data-interaction'), 'samples are a separate, droppable tier');

  assert.ok(samples.includes('<div data-interaction'), 'the matched markup goes in the bulky tier');
});

test('an uploaded snapshot turns the issue into a small, complete body with a link', () => {
  // The point of uploading: the report stops being a trimmed fragment plus a
  // paste instruction, and becomes a short body linking the whole snapshot.
  const { buildBody, fitIssue, URL_BUDGET } = loadReportHelpers();
  const parts = {
    symptoms: [{ label: 'The page will not scroll' }],
    description: 'It froze.',
    environment: { 'Keep Scrolling': '1.2.3 (45)' },
    pageState: '{"scrollable": false}',
    diagnostics: '{"overlays": []}',
    html: '',
    htmlLink: PASTE_LINK,
  };

  // countOccurrences rather than `body.includes(PASTE_LINK)`: a substring test
  // against a URL literal reads to code scanning as a bypassable host check
  // (js/incomplete-url-substring-sanitization) even here, where the string
  // being searched is a markdown body and nothing is being authorized. Saying
  // "the link appears once" is both what this means and not that shape.
  const body = buildBody(parts);
  assert.equal(countOccurrences(body, `](${PASTE_LINK})`), 1, 'the issue must link the uploaded snapshot');
  assert.ok(!/paste it here/i.test(body), 'no paste instruction when the snapshot is linked');
  assert.ok(!body.includes('<details><summary>Page HTML'), 'the inline block is redundant with a link');

  const fitted = fitIssue('Page will not scroll on x.com', parts, URL_BUDGET);
  assert.equal(fitted.truncated, false, 'a linked report fits the prefilled URL whole');
  assert.equal(countOccurrences(fitted.body, PASTE_LINK), 1, 'the link survives into the prefilled URL');
  assert.ok(fitted.body.includes('{"overlays": []}'), 'and the diagnostics now fit alongside it');

  // A partial upload must be labelled, or the snapshot looks complete.
  assert.ok(/middle was cut/i.test(buildBody({ ...parts, htmlPartial: true })));

  // The pending state is what the preview shows before anything is sent.
  const pending = buildBody({ ...parts, htmlLink: '', htmlPending: true });
  assert.ok(/will be uploaded/i.test(pending), 'the preview must disclose the upload before it happens');

  // When there is no link, the issue says which of the three reasons it was.
  // A report that merely lacks a link cannot be told apart from one where the
  // user declined, and the difference is the whole diagnosis.
  const reasons = [
    'declined by the reporter',
    'not allowed by Safari for paste.rs, so the snapshot is on the reporter’s clipboard',
    'attempted but failed (host unreachable, rate limited, or blocked)',
  ];
  for (const reason of reasons) {
    const body = buildBody({ ...parts, htmlLink: '', htmlOmitted: true, uploadOutcome: reason });
    assert.ok(body.includes(`Snapshot upload: ${reason}.`), `the issue must record: ${reason}`);
    assert.ok(/paste it here/i.test(body), 'and still point at the clipboard copy');
  }
  assert.ok(
    !/Snapshot upload:/.test(buildBody({ ...parts, htmlLink: '', htmlOmitted: true })),
    'no outcome line when there was nothing to upload',
  );
});

test('the clipboard copy fits GitHub’s hard 65536-character issue body', () => {
  // GitHub rejects an over-long body outright — "Body can not be longer than
  // 65536 characters" — so the copy the user pastes is budgeted like the URL.
  // An untrimmed copy is not a bigger report, it is a report that cannot be
  // filed at all.
  const { fitClipboard, BODY_BUDGET } = loadReportHelpers();
  assert.ok(BODY_BUDGET <= 65536, 'the budget must stay under GitHub’s hard limit');

  const parts = {
    symptoms: [{ label: 'The page will not scroll' }],
    description: 'It froze after a few seconds.',
    environment: { 'Keep Scrolling': '1.2.3 (45)' },
    pageState: '{"scrollable": false}',
    diagnostics: '{"overlays": []}',
    html: `<html><head>${'<link rel="modulepreload" href="/a.js">'.repeat(9000)}</head>`
      + `<body>${'<div>filler</div>'.repeat(9000)}`
      + '<div data-interaction="app-store-obstruction">See this post in the app</div></body></html>',
  };

  const fitted = fitClipboard(parts, BODY_BUDGET);
  assert.ok(fitted.body.length <= BODY_BUDGET, `clipboard body ${fitted.body.length} over budget`);
  assert.ok(fitted.truncated, 'a trimmed copy must say so, so the caller can tell the user');
  assert.ok(fitted.body.includes(parts.description), 'the user’s own words survive');
  assert.ok(fitted.body.includes('{"scrollable": false}'), 'the lock state survives');

  // Both ends of the document, because both carry evidence: the preloads in
  // <head>, and the nag appended at the end of <body>.
  assert.ok(fitted.body.includes('<html><head><link rel="modulepreload"'), 'the head of the page survives');
  assert.ok(
    fitted.body.includes('data-interaction="app-store-obstruction"'),
    'the END of the document must survive — a late-injected nag is exactly what a prefix loses',
  );
  assert.ok(/cut from the middle/.test(fitted.body), 'the cut must be marked, not silently joined');

  // A report that already fits is passed through untouched.
  const small = fitClipboard({ ...parts, html: '<html>small</html>' }, BODY_BUDGET);
  assert.equal(small.truncated, false);
  assert.ok(small.body.includes('<html>small</html>'));
});

test('trimMiddle keeps both ends and never exceeds what it was given', () => {
  const { trimMiddle } = loadReportHelpers();
  const html = `START${'x'.repeat(50000)}END`;
  const trimmed = trimMiddle(html, 5000);
  assert.ok(trimmed.startsWith('START'), 'the head must be the head');
  assert.ok(trimmed.endsWith('END'), 'the tail must be the tail');
  assert.ok(trimmed.length < 5400, `marker aside, the result must respect the budget: ${trimmed.length}`);
  assert.equal(trimMiddle('short', 5000), 'short', 'what already fits is untouched');
});

test('a realistic report keeps the lock state AND the overlay summary inside the real budget', () => {
  // The regression this guards: a diagnostics block big enough to be dropped by
  // fitIssue on every real page is the same as not collecting it at all. Sized
  // against a logged-out X status page — long URL, long user agent, a modal
  // over a backdrop over a banner, a page's worth of preloaded modules.
  const { describeSnapshot, fitIssue, SYMPTOMS, URL_BUDGET } = loadReportHelpers();
  const overlay = (name, text) => ({
    coverage: 1,
    position: 'fixed',
    zIndex: '50',
    pointerEvents: 'auto',
    touchAction: 'none',
    tag: `<div role="dialog" aria-modal="true" data-state="open" data-interaction="${name}" class="group fixed inset-0 z-50 flex touch-none items-center justify-center">`,
    text,
  });
  const snapshot = {
    url: 'https://x.com/SomeAccountName/status/1234567890123456789?s=46&t=AbCdEfGhIjKlMnOpQrSt',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    viewport: '390x844 @3x',
    scriptsActive: { reddit: false, x: true },
    lock: {
      scrollable: false,
      elements: [
        { element: 'html', present: true, class: '', style: '', computed: { overflow: 'visible', position: 'static', touchAction: 'auto', pointerEvents: 'auto' } },
        { element: 'body', present: true, class: '', style: 'position: fixed; top: -1840px; left: 0px; right: 0px; height: auto;', computed: { overflow: 'visible', position: 'fixed', touchAction: 'auto', pointerEvents: 'auto' } },
      ],
    },
    signatures: [{ selector: '[href*="launch_app_store=true"]', count: 12, sample: 'x'.repeat(1500) }],
    overlays: [
      overlay('app-store-obstruction', 'See this post in the app Use the app to view all comments and discover more posts.'),
      overlay('app-store-obstruction-backdrop', ''),
      overlay('bottom-prompt', 'Open X App See all the replies'),
    ],
    components: ['logged-out-open-app-banner', 'bottom-prompt', 'tap-hand', 'use-jetfuel-modal-state', 'modal', 'popover-sheet', 'vaul', 'use-may-obstruct'],
  };

  const { environment, pageState, diagnostics, samples } = describeSnapshot(snapshot, { version: '1.2.3', build: '45' });
  const fitted = fitIssue('Page will not scroll on x.com', {
    symptoms: [SYMPTOMS[1], SYMPTOMS[2]],
    description: 'Nothing on screen but the page would not move.',
    environment,
    pageState,
    diagnostics,
    samples,
    html: '<html>'.padEnd(200000, 'x'),
  }, URL_BUDGET);

  assert.ok(fitted.url.length <= URL_BUDGET, `URL ${fitted.url.length} over budget ${URL_BUDGET}`);
  assert.ok(fitted.body.includes('### Page state'), 'the lock state must reach the issue');
  assert.ok(
    fitted.body.includes('### Overlays and components'),
    'the overlay summary must reach the issue — dropped on every real page, it is dead weight',
  );
  assert.ok(fitted.body.includes('app-store-obstruction'), 'the overlay must still be named');
  assert.ok(fitted.body.includes('logged-out-open-app-banner'), 'the component names must survive');
  assert.ok(/paste it here/i.test(fitted.body), 'and the page HTML must be marked as pending a paste');
});

test('the overlay list is trimmed for the URL, since it has to survive the trim to be worth having', () => {
  const { describeSnapshot } = loadReportHelpers();
  const { diagnostics } = describeSnapshot(
    {
      overlays: Array.from({ length: 8 }, (unused, i) => ({
        coverage: 1,
        tag: `<div id="overlay-${i}" ${'data-x="y" '.repeat(60)}>`,
        text: 'w'.repeat(500),
      })),
      components: ['vaul'],
    },
    { version: '1.2.3' },
  );
  const parsed = JSON.parse(diagnostics);
  assert.equal(parsed.overlays.length, 3, 'only the biggest covers are worth the budget');
  assert.ok(parsed.overlays[0].tag.length < 200, 'the opening tag is trimmed');
  assert.ok(parsed.overlays[0].text.length < 120, 'the visible text is trimmed');
  assert.ok(parsed.overlays[0].tag.includes('id="overlay-0"'), 'trimming keeps the identifying head of the tag');

  // A page can only be so hostile: worst case this block plus the page state
  // still leaves room inside URL_BUDGET, which is the whole point of trimming
  // it here rather than letting fitIssue drop it.
  assert.ok(diagnostics.length < 1500, `the kept tier must stay small, got ${diagnostics.length}`);
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

  // Sloppy-but-valid end tags and `>` inside a quoted value are exactly the
  // shapes that slip past a naive filter and report the value verbatim
  // (CodeQL's js/bad-tag-filter).
  for (const [markup, secret] of [
    ['<script>var t = "s3cret";</script >', 's3cret'],
    ['<style>body { background: url(s3cret) }</style foo>', 's3cret'],
    ['<textarea>s3cret</textarea\n>', 's3cret'],
    ['<meta content="s3cret" name="a > b csrf-token">', 's3cret'],
    ['<input title="a > b" value="s3cret">', 's3cret'],
  ]) {
    assert.ok(!sanitizeHtml(markup).includes(secret), `sanitizeHtml left ${secret} in: ${markup}`);
  }

  // …while keeping the markup that a nag report is actually about.
  const nag = '<rpl-bottom-sheet blocking open id="app-upsell-blocking-bottom-sheet-seo"></rpl-bottom-sheet>';
  assert.equal(sanitizeHtml(nag), nag);
});

test('every <meta> content is redacted by default, not just credential-shaped names', () => {
  // Matching on the name only ever caught the honest cases. The head is also
  // where a page parks its CSP nonce, its Sentry trace/baggage ids, request ids
  // and build hashes, under names no pattern predicts — and none of it helps
  // diagnose a nag, so redacting the lot costs nothing.
  const source = scriptCollect.match(/function sanitizeHtml\(html\) \{[\s\S]*?\n  \}/);
  const sanitizeHtml = new Function(`${source[0]}; return sanitizeHtml;`)();

  for (const markup of [
    '<meta name="sentry-trace" content="s3cret">',
    '<meta name="baggage" content="sentry-trace_id=s3cret">',
    '<meta property="csp-nonce" content="s3cret">',
    '<meta name="request-id" content="s3cret">',
    '<meta name="build" content="s3cret">',
    '<meta name="og:description" content="s3cret">',
  ]) {
    assert.ok(!sanitizeHtml(markup).includes('s3cret'), `sanitizeHtml left a value in: ${markup}`);
  }

  // A CSP nonce also rides on the tags themselves, wherever they appear.
  assert.ok(!sanitizeHtml('<div nonce="s3cret"></div>').includes('s3cret'), 'nonce attributes must be redacted');

  // The layout-describing handful survives — a nag that covers the viewport is
  // occasionally a viewport-meta question.
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  assert.equal(sanitizeHtml(viewport), viewport);
  assert.equal(sanitizeHtml('<meta charset="utf-8">'), '<meta charset="utf-8">');
});

test('the collector names the unrecognised overlays covering the page', () => {
  // "The whole page is obstructed" is only actionable if the report says WHAT
  // is obstructing it. Every nag so far — Reddit's sheet, X's modal, X's vaul
  // drawer — is a pinned element over a good part of the viewport.
  const element = (outerHTML, computed, rect, textContent = '') => ({
    outerHTML,
    textContent,
    computed,
    getBoundingClientRect: () => rect,
  });
  const full = { width: 400, height: 800 };
  const style = (over) => ({
    position: 'fixed',
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    zIndex: '50',
    pointerEvents: 'auto',
    touchAction: 'none',
    ...over,
  });

  const elements = [
    element('<div class="topbar">…</div>', style({ position: 'sticky' }), { width: 400, height: 40 }),
    element('<div class="cookie">…</div>', style({ display: 'none' }), full),
    element(
      '<div role="dialog" data-interaction="app-store-obstruction" class="fixed inset-0"><p>x</p></div>',
      style({}),
      full,
      '  See this post\n  in the app  ',
    ),
    element('<aside class="fixed bottom-0">…</aside>', style({ zIndex: '40' }), { width: 400, height: 200 }),
  ];

  const collectOverlays = loadCollectorFunction('collectOverlays', {
    document: { body: { querySelectorAll: () => elements } },
    window: { innerWidth: 400, innerHeight: 800 },
    getComputedStyle: (el) => el.computed,
    sanitizeHtml: (html) => html,
    truncate: (text, limit) => (text || '').slice(0, limit),
    OVERLAY_LIMIT: 8,
    OVERLAY_MIN_COVERAGE: 0.1,
    OVERLAY_SCAN_LIMIT: 8000,
    TAG_LIMIT: 300,
  });

  const overlays = collectOverlays();
  assert.equal(overlays.length, 2, 'small pinned chrome and hidden elements are not overlays');
  assert.equal(overlays[0].coverage, 1, 'the biggest cover comes first');
  assert.equal(
    overlays[0].tag,
    '<div role="dialog" data-interaction="app-store-obstruction" class="fixed inset-0">',
    'report the opening tag only — the id/class/data-* a new selector gets built from',
  );
  assert.equal(overlays[0].text, 'See this post in the app', 'the visible words identify the nag');
  assert.equal(overlays[1].coverage, 0.25);
  assert.ok(overlays[0].touchAction === 'none' && overlays[0].pointerEvents === 'auto');
});

test('the collector reports the component names the page preloaded, hash-stripped', () => {
  // `logged-out-open-app-banner-*.js` named X's banner and vaul's stylesheet
  // named the scroll lock before either was ever matched in the DOM — and a
  // few hundred bytes of names survive into an issue that page HTML cannot.
  const link = (attrs) => ({ getAttribute: (name) => attrs[name] || null });
  const collectComponents = loadCollectorFunction('collectComponents', {
    document: {
      querySelectorAll: () => [
        link({ href: '/assets/logged-out-open-app-banner-D4f8Xq2b.js' }),
        link({ href: '/assets/logged-out-open-app-banner-Zz91Ab77.js' }),
        link({ src: 'https://abs.twimg.com/vaul-a1b2c3d4e5.js?v=2' }),
        link({ src: '/bundle.js' }),
      ],
    },
    COMPONENT_LIMIT: 60,
  });

  assert.deepEqual(collectComponents(), ['logged-out-open-app-banner', 'vaul', 'bundle'],
    'strip the content hash so a redeploy does not read as a new component, and de-duplicate');
});

test('the collector still only reads the page after growing new diagnostics', () => {
  for (const call of ['collectOverlays()', 'collectComponents()']) {
    assert.ok(scriptCollect.includes(call), `collect() must gather ${call}`);
  }
  // getBoundingClientRect/getComputedStyle are reads; the read-only guard in
  // the collector test above covers the mutation side.
  assert.ok(
    scriptCollect.includes('OVERLAY_SCAN_LIMIT'),
    'the overlay scan must be capped — it touches every element on the page',
  );
});

test('the collector caps the page HTML from the MIDDLE, keeping the end of <body>', () => {
  // The cap used to keep the head. On a page bigger than the cap that threw
  // away the end of <body> — the one place a late-injected nag actually is —
  // so the snapshot was capped to the part that never contains the bug.
  const source = scriptCollect.match(/function clampDocument\(html, limit\) \{[\s\S]*?\n  \}/);
  assert.ok(source, 'clampDocument() not found in collect-report.js');
  const clampDocument = new Function(`${source[0]}; return clampDocument;`)();

  const html = `<html><head>PRELOADS</head><body>${'x'.repeat(20000)}<div id="nag"></div></body></html>`;
  const clamped = clampDocument(html, 4000);
  assert.ok(clamped.length < 4400, `clamped to ${clamped.length}, budget 4000 plus marker`);
  assert.ok(clamped.includes('PRELOADS'), 'the head carries the preloads that named both variants');
  assert.ok(clamped.includes('<div id="nag"></div></body></html>'), 'the end of the document must survive');
  assert.ok(/cut from the middle/.test(clamped), 'the cut must be marked');
  assert.equal(clampDocument('<html>tiny</html>', 4000), '<html>tiny</html>');

  assert.ok(
    scriptCollect.includes('html: clampDocument('),
    'the page HTML must go through clampDocument, not the head-first truncate()',
  );
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
    /^\s*apply_build_info\(ext_resources, marketing_version, build_number\)$/m.test(fastfile),
    'apply_build_info must be called from generate_project, with the resolved resources directory',
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

test('the Fastfile bundles extension files the manifest never names', () => {
  // build-info.json is named only in report.js's runtime.getURL, so it cannot
  // rely on being a manifest resource to ship. Nothing in extension/ may.
  const named = JSON.stringify(manifest);
  assert.ok(!named.includes('build-info.json'), 'build-info.json is deliberately not a manifest resource');

  assert.ok(/def sync_extension_resources/.test(fastfile), 'sync_extension_resources must exist');
  assert.ok(
    /^\s*ext_resources = sync_extension_resources\(proj, ext\)$/m.test(fastfile),
    'sync_extension_resources must be called from generate_project and its resources dir captured',
  );
  // Ordering: the stamp writes into the copy the sync is responsible for making.
  assert.ok(
    fastfile.indexOf('sync_extension_resources(proj, ext)') <
      fastfile.indexOf('apply_build_info(ext_resources,'),
    'sync_extension_resources must run before apply_build_info',
  );
  // Copying is only half of it — an unreferenced file is copied and then never
  // bundled, which is exactly the failure apply_app_ui sidesteps.
  assert.ok(
    /def register_resource/.test(fastfile) && /resources_build_phase/.test(fastfile),
    'a copied-in file must also be registered in the target’s Copy Bundle Resources phase',
  );
});

test('the Fastfile locates the appex resources via the project, not a build/gen glob', () => {
  // Two releases died on globbing build/gen for a file the converter never put
  // there: v0.6.0 on build-info.json, v0.6.1 on manifest.json itself. The
  // generated project references the tracked extension/ (and `Dir.glob "**"`
  // does not descend into a symlinked directory either), so the project — not
  // the filesystem — is the only authoritative source for that path.
  assert.ok(
    !/Dir\.glob\(File\.join\(GEN_DIR, "\*\*", (BUILD_INFO_FILE|"manifest\.json")\)\)/.test(fastfile),
    'do not search build/gen for the extension’s own files — ask the target’s resources build phase',
  );
  assert.ok(
    /def locate_extension_resources/.test(fastfile),
    'the resources directory must be resolved from the resources build phase',
  );
  // Stamping through a reference to the tracked tree would dirty the working
  // tree on a dev machine, so the referenced tree is copied under build/gen first.
  assert.ok(
    /def privatise_extension_resources/.test(fastfile) && /File\.realpath/.test(fastfile),
    'a project pointing at the tracked extension/ must be repointed at a build/gen copy',
  );
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

// ── Scroll harness (test/scroll) ──────────────────────────────────────────
// The harness needs a browser, so it runs separately (`node test/scroll/run.mjs`).
// What CAN be guarded here for free is the one thing that makes it worth having.

test('the scroll harness drives real touch, never a programmatic scroll', () => {
  // window.scrollBy / scrollIntoView / wheel / synthesizeScrollGesture all
  // ignore touch-action, so a harness built on them passes happily against a
  // page no finger can move — which is precisely issue #25. Only
  // Input.dispatchTouchEvent goes through the path that honours it.
  assert.ok(
    scrollHarness.includes('Input.dispatchTouchEvent'),
    'the harness must drive touch events over CDP',
  );
  const code = scrollHarness.replace(/^\s*\/\/.*$/gm, '');
  for (const fake of ['window.scrollBy', 'scrollIntoView', 'synthesizeScrollGesture', 'dispatchMouseEvent']) {
    assert.ok(
      !code.includes(fake),
      `${fake} does not exercise touch-action — it would pass against a frozen page`,
    );
  }
  // Touch input does not exist at all without these two.
  assert.ok(scrollHarness.includes('Emulation.setTouchEmulationEnabled'), 'touch emulation must be on');
  assert.ok(/mobile: true/.test(scrollHarness), 'the viewport must be emulated as mobile');
});

test('WebKit is optional and never a hidden dependency of the harness', () => {
  // The pan test drives Chromium because only Chromium can synthesize a trusted
  // touch drag. WebKit answers the other half — what the reader can reach — and
  // that half is engine-sensitive, so it is worth having and must stay optional:
  // it is the one piece needing an npm install.
  assert.ok(/await import\('playwright-core'\)/.test(scrollWebkit),
    'playwright-core must be imported dynamically so its absence is not fatal');
  assert.ok(/install-deps webkit/.test(scrollWebkit),
    'record the step that actually blocks a WebKit install: the download succeeds, '
    + 'then validation fails on missing system libraries');
  assert.ok(/webkitAvailable/.test(scrollRunner) && /SKIP --webkit/.test(scrollRunner),
    '--webkit must degrade to a clear skip, not an error');
  assert.ok(/node_modules\//.test(gitignore), 'node_modules must never be committed');
});

test('CodeQL still covers everything that actually ships', () => {
  // The scroll harness is scoped out because "download a page and write it to
  // disk" is its purpose, not a defect. That is only defensible while the
  // shipped code stays fully in scope — so pin it.
  const config = readFileSync(join(root, '.github', 'codeql-config.yml'), 'utf8');
  for (const shipped of ['extension', 'app']) {
    assert.ok(
      new RegExp(`^\\s*-\\s*${shipped}\\s*$`, 'm').test(config),
      `${shipped}/ must stay in CodeQL scope — it is what runs on a user's phone`,
    );
  }
  assert.ok(
    /config-file: \.\/\.github\/codeql-config\.yml/.test(security),
    'the workflow must actually use the config',
  );
  assert.ok(/security-extended/.test(security), 'keep the extended query set');
});

test('the harness does not run itself when node --test discovers it', () => {
  // `node --test` treats every file under test/ as a test file and sets
  // process.argv[1] to it, so the usual "was I run directly?" check is true
  // there too — which made a bare `node --test` drive a browser through every
  // fixture as a side effect, and fail on mirror.mjs printing its usage.
  for (const [name, src] of [['run.mjs', scrollRunner], ['mirror.mjs', scrollMirror]]) {
    assert.ok(
      /!process\.env\.NODE_TEST_CONTEXT/.test(src),
      `${name} must not execute under the test runner`,
    );
  }
  assert.ok(
    /node --test test\/extension\.test\.js/.test(ci),
    'CI must scope the unit tests to the file that holds them',
  );
});

test('every scroll fixture emulates a phone viewport', () => {
  // Without <meta name="viewport"> Chrome lays a page out at 980px and scales
  // it, so a 4000px fixture reported 2227px of scroll at a 796px viewport
  // instead of 3204px. Real mobile pages ship the meta; the fixtures have to
  // as well or every distance the harness prints is quietly wrong.
  const dir = join(root, 'test', 'scroll', 'fixtures');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(dir, name), 'utf8');
    assert.ok(
      /<meta name="viewport" content="width=device-width/.test(html),
      `${name} must declare a device-width viewport`,
    );
  }
});

test('scroll distance is reported, not just a scrollable boolean', () => {
  // Issue #28: 590px of scroll, every pixel of it released by the extension,
  // and the page still read as frozen because that was the whole page. A
  // boolean cannot tell that from a lock; a distance can.
  for (const [what, src] of [['harness', scrollHarness], ['collector', scriptCollect]]) {
    assert.ok(/maxScroll/.test(src), `${what} must report how far the page can travel`);
    assert.ok(/screens/.test(src), `${what} must report how much page there is`);
  }
  assert.ok(/maxScroll: snapshot\.lock\.maxScroll/.test(scriptReport),
    'the issue body must carry the scroll distance');
  assert.ok(/of \$\{r\.maxScroll\}px available/.test(scrollRunner),
    'the harness output must show the distance panned against the distance available');
});

test('the scroll harness asserts the control, not just the fix', () => {
  // A freeze fixture that pans WITHOUT the content script is not reproducing
  // anything, and a fix measured against it has been measured wrong.
  assert.ok(
    /the control panned .* not reproducing a freeze/.test(scrollRunner),
    'a fixture whose control pans must fail the run',
  );
  assert.ok(
    /the harness itself is broken/.test(scrollRunner),
    'the plain fixture must fail the run if it stops panning',
  );
  // "still locked" and "there was never any page to move" are different
  // findings; calling the second one a lock sends the next reader hunting for
  // something that was never there.
  assert.ok(
    /nothing is locked, there is just no page to move/.test(scrollRunner),
    'a short page must not be reported as a lock',
  );
  assert.ok(
    /process\.exit\(77\)/.test(scrollRunner),
    'must exit 77 (skip) with no browser, so `node --test` stays dependency-free',
  );
});

test('every documented freeze shape has a scroll fixture', () => {
  const fixtures = readdirSync(join(root, 'test', 'scroll', 'fixtures'))
    .filter((name) => name.endsWith('.html'));
  // One per mechanism the extension has actually met, plus the plain control.
  for (const required of [
    'plain.html',              // nothing wrong — proves the harness can pan
    'touch-action-cover.html', // issue #25
    'inline-touch-action.html',
    'overflow-hidden.html',    // the original inline lock
    'vaul-pinned.html',        // vaul's position:fixed pin
    'base-ui-mobile.html',     // Base UI, no-scrollbar path
    'base-ui-desktop.html',    // Base UI, scrollbar path
    'short-page.html',         // issue #28: nothing locked, nothing to scroll
  ]) {
    assert.ok(fixtures.includes(required), `missing scroll fixture: ${required}`);
  }
});
