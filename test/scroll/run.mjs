#!/usr/bin/env node
// run.mjs — does the page actually pan, and did the content script make the
// difference?
//
//   node test/scroll/run.mjs                 the committed fixtures
//   node test/scroll/run.mjs snapshot.html   a page from a bug report
//   node test/scroll/run.mjs https://x.com/…/status/…   a live page
//   node test/scroll/run.mjs https://x.com/…  --with-js  mirror it and run the
//                                                        site's real bundle
//
// Plain URL mode blocks every request, so the site's own client code never
// runs — enough for a server-rendered cover, not enough for a lock a site
// applies from a React effect. --with-js mirrors the page and its whole module
// graph to a temp directory, serves it from localhost, and lets it hydrate with
// no internet reachable. See mirror.mjs for what that does and does not copy.
//
// Every case is run twice: once WITHOUT the content script, once WITH it. Both
// halves are assertions. A frozen fixture that pans in the control is not
// reproducing anything, and a fix that "passes" against a page which was never
// stuck has been measured wrong — that is exactly how issue #25 got shipped
// past a green test run.
//
// Needs a Chrome/Chromium binary; set CHROME_PATH if it is somewhere unusual.
// Exits 0 if every case behaved, 1 if any did not, and 77 (skipped) if there is
// no browser to drive — `node --test` stays dependency-free and this stays
// optional.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from './cdp.mjs';
import { panTest } from './harness.mjs';
import { mirror, serve } from './mirror.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

// Both nag scripts, exactly as Safari would run them. A fixture is normally
// about one of them, but running both mirrors the shipped extension and costs
// nothing.
const CONTENT_SCRIPTS = ['block-reddit-nag.js', 'block-x-nag.js']
  .map((name) => readFileSync(join(ROOT, 'extension', name), 'utf8'))
  .join('\n;\n');

// A pan of less than this is a rounding artefact, not a scroll.
const PANNED = 50;

function describe(r) {
  const bits = [
    `of ${r.maxScroll}px available (${r.screens} screens)`,
    `html.overflow-y=${r.htmlOverflowY}`,
    `body.overflow-y=${r.bodyOverflowY}`,
  ];
  if (r.blocker) bits.push(`blocked by ${r.blocker.touchAction} on ${r.blocker.tag}`);
  return bits.join(', ');
}

// A page barely longer than the viewport cannot be panned far no matter what
// the extension does, and "moved 40px" then looks like a failure. Issue #28 was
// the reverse mistake made by a reader: 590px of scroll, every pixel of it
// released, and it still felt frozen because that was the whole page.
const NOT_MUCH_PAGE = 120;

// A live or captured page keeps its stylesheets — without them the Tailwind
// classes that carry `touch-action: none` are inert and the page pans happily,
// so the fixture reproduces nothing. Everything else stays blocked.
async function materialize(target, withJs) {
  if (!/^https?:/.test(target)) return { url: pathToFileURL(resolve(target)).href, offline: true };

  if (withJs) {
    const dir = mkdtempSync(join(tmpdir(), 'keep-scrolling-mirror-'));
    await mirror(target, dir, { log: (line) => console.log(`  ${line}`) });
    const server = await serve(dir);
    // settle: the site has to boot and mount before a drag means anything.
    return { url: `${server.origin}/index.html`, allowOrigin: server.origin, settle: 6000, server };
  }

  const dir = mkdtempSync(join(tmpdir(), 'keep-scrolling-page-'));
  const res = await fetch(target, { headers: { 'User-Agent': IPHONE_UA, 'Accept-Language': 'en' } });
  let html = await res.text();
  const hrefs = [...new Set(
    [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]),
  )];
  for (const [index, href] of hrefs.entries()) {
    const name = `sheet-${index}.css`;
    try {
      const css = await (await fetch(href, { headers: { 'User-Agent': IPHONE_UA } })).text();
      writeFileSync(join(dir, name), css);
      html = html.split(href).join(name);
    } catch { /* leave the remote href; it will simply be blocked */ }
  }
  const file = join(dir, 'page.html');
  writeFileSync(file, html);
  return { url: pathToFileURL(file).href, offline: true };
}

// What a fixture is for. Naming the three outcomes beats a boolean, because the
// third one is a real, correct result that used to be indistinguishable from a
// failure — and mistaking it for one is how a reader ends up hunting a lock
// that was never there (issue #28).
const EXPECT = {
  'plain.html': 'healthy',       // nothing wrong: must pan either way
  'short-page.html': 'no-page',  // nothing locked, and almost nothing to scroll
};
const DEFAULT_EXPECT = 'frozen'; // stuck without the scripts, panning with them

async function runCase(name, target, expect, withJs = false) {
  const { url, offline, allowOrigin, settle, server } = await materialize(target, withJs);
  const opts = { url, offline, allowOrigin, settle };
  const control = await panTest(opts);
  const fixed = await panTest({ ...opts, inject: CONTENT_SCRIPTS });
  if (server) server.close();

  const controlPanned = control.moved >= PANNED;
  const fixedPanned = fixed.moved >= PANNED;
  const shortPage = fixed.maxScroll < NOT_MUCH_PAGE;
  const problems = [];

  if (expect === 'frozen' && controlPanned) {
    problems.push(`the control panned ${control.moved}px — this fixture is not reproducing a freeze`);
  }
  if (expect === 'healthy' && !controlPanned) {
    problems.push(`the control did not pan (${control.moved}px) — the harness itself is broken`);
  }
  if (expect === 'no-page') {
    // The whole point of this case: prove the page is short rather than locked.
    if (!shortPage) problems.push(`expected a page with nothing to scroll, got ${fixed.maxScroll}px`);
    if (fixed.blocker) problems.push(`something is refusing the drag: ${fixed.blocker.tag}`);
  } else if (!fixedPanned) {
    // Distinguish "still locked" from "there was nothing to scroll". Only the
    // first is a bug in this extension.
    problems.push(shortPage
      ? `the page is only ${fixed.screens} screens long (${fixed.maxScroll}px of scroll) — `
        + 'nothing is locked, there is just no page to move'
      : `WITH the content script the page still did not pan (${fixed.moved}px `
        + `of ${fixed.maxScroll}px available)`);
  }

  const verdict = problems.length ? 'FAIL' : 'ok  ';
  console.log(`${verdict} ${name}`);
  console.log(`       without: ${String(control.moved).padStart(4)}px  ${describe(control)}`);
  console.log(`       with:    ${String(fixed.moved).padStart(4)}px  ${describe(fixed)}`);
  for (const problem of problems) console.log(`       ↳ ${problem}`);
  return problems.length === 0;
}

async function main() {
  if (!findChrome()) {
    console.log('SKIP: no Chrome/Chromium binary found. Set CHROME_PATH to run the scroll harness.');
    process.exit(77);
  }

  const args = process.argv.slice(2);
  const withJs = args.includes('--with-js');
  const [target] = args.filter((a) => !a.startsWith('--'));
  let results = [];

  if (target) {
    // A page from a bug report, or a live one. We do not know whether it is
    // stuck, so the control is reported but not asserted — reading it IS the
    // diagnosis.
    console.log(`Panning ${target}${withJs ? ' (mirrored, running its real JavaScript)' : ''}\n`);
    results.push(await runCase(target, target, 'report', withJs));
  } else {
    const dir = join(HERE, 'fixtures');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
      results.push(await runCase(file, join(dir, file), EXPECT[file] || DEFAULT_EXPECT));
    }
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// Only when run as a command — see mirror.mjs. Without this, `node --test`
// drives a browser through every fixture as a side effect of discovering files.
const RUN_DIRECTLY = !process.env.NODE_TEST_CONTEXT
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) main().catch((err) => { console.error(err); process.exit(1); });
