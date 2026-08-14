// harness.mjs — can a finger actually pan this page?
//
// The whole point of this file is the *touch* part. Issue #25 was a full-screen
// `touch-action: none` cover over a page that reported `scrollable: true`,
// `overflow: visible` on <html> and <body>, and no lock anywhere. Every way of
// scrolling a page programmatically walks straight past that:
//
//   window.scrollBy(0, 500)                  ignores touch-action entirely
//   element.scrollIntoView()                 same
//   Input.dispatchMouseEvent (wheel)         wheel is not a touch; touch-action
//                                            does not apply
//   Input.synthesizeScrollGesture            did not move the page at all in a
//                                            headless run — silently passes
//
// A run built on any of those reports "the page scrolls" against a page no
// finger can move, which is exactly the failure being tested for. So the drag
// below is a real touchStart / touchMove× / touchEnd sequence over CDP, which
// goes through the renderer's input pipeline and honours touch-action.
//
// The other half is the control: the same page WITHOUT the content script must
// fail to pan. A fixture that pans either way proves nothing, and a harness
// that only ever checks the fixed case cannot tell "we fixed it" from "it was
// never broken".

import { launch, newPage } from './cdp.mjs';

const VIEWPORT = { width: 440, height: 796 };

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed');
  return result.value;
}

// A finger drag upward through the middle of the viewport. Many small moves
// rather than one big jump: a single touchMove can be treated as a fling or
// discarded, and the intermediate points are what a real drag looks like.
async function drag(page, { from = 600, to = 100, step = 25, x = VIEWPORT.width / 2 } = {}) {
  const points = (y) => [{ x, y, radiusX: 10, radiusY: 10, force: 1 }];
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let y = from; y >= to; y -= step) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(y) });
    await new Promise((r) => setTimeout(r, 8));
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// What is under the reader's finger, and can it pan? Mirrors the `lock.pan`
// probe the bug reporter collects, so a harness run and a filed report describe
// the same page in the same words.
const PROBE = `(() => {
  const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  const blocks = (v) => v !== 'auto' && v !== 'manipulation' && !/\\b(pan-y|pan-up|pan-down)\\b/.test(v);
  let blocker = null;
  for (let node = el; node && node.nodeType === 1 && !blocker; node = node.parentElement) {
    const s = getComputedStyle(node);
    if (blocks(s.touchAction)) blocker = { tag: node.outerHTML.slice(0, node.outerHTML.indexOf('>') + 1), touchAction: s.touchAction, position: s.position };
  }
  const html = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const height = document.scrollingElement.scrollHeight;
  return {
    scrollable: height - innerHeight > 4,
    // How far the page COULD go. "panned 590px" is only good news next to it:
    // issue #28 was a page with exactly 590px of scroll in it, fully released,
    // that still read as frozen because that is all the page there was.
    maxScroll: Math.max(0, Math.round(height - innerHeight)),
    screens: Math.round((height / innerHeight) * 10) / 10,
    htmlOverflowY: html.overflowY, bodyOverflowY: body.overflowY,
    htmlPosition: html.position, bodyPosition: body.position,
    blocker,
  };
})()`;

/**
 * Load a page and try to pan it with a real touch drag.
 *
 * @param {object}  opts
 * @param {string}  opts.url          page to load (file:// or http(s)://)
 * @param {string} [opts.inject]      content-script source to run at document_start
 * @param {boolean}[opts.offline]     block every request except the page itself
 * @param {string} [opts.allowOrigin] allow requests to this origin only, so a
 *   mirrored copy can run the site's real JavaScript with no internet
 * @param {number} [opts.settle]      ms to wait before dragging (hydration)
 * @returns {Promise<{moved:number, before:number, after:number, ...probe}>}
 */
export async function panTest({ url, inject, offline = true, allowOrigin, settle = 400 }) {
  const browser = await launch(VIEWPORT);
  try {
    const page = await newPage(browser);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // isMobile + touch emulation: without these there is no touch input path at
    // all and every drag silently does nothing.
    await page.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT, deviceScaleFactor: 3, mobile: true,
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    if (allowOrigin) {
      // Everything the mirrored copy needs is same-origin; anything else is the
      // live site leaking back in, which would make the run non-reproducible.
      // Blocklists cannot express "all but this one origin", so gate each
      // request instead.
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      page.on('Fetch.requestPaused', ({ requestId, request }) => {
        const allowed = request.url.startsWith(allowOrigin) || request.url.startsWith('data:');
        page.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      });
    } else if (offline) {
      await page.send('Network.enable');
      await page.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    }
    if (inject) {
      // document_start, the same moment Safari gives the real content script.
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    }

    const loaded = new Promise((resolve) => page.on('Page.loadEventFired', resolve));
    await page.send('Page.navigate', { url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 30000))]);
    await new Promise((r) => setTimeout(r, settle));

    const before = await evaluate(page, 'window.scrollY');
    await drag(page);
    await new Promise((r) => setTimeout(r, 600));
    const after = await evaluate(page, 'window.scrollY');
    const probe = await evaluate(page, PROBE);

    page.close();
    return { before, after, moved: after - before, ...probe };
  } finally {
    await browser.close();
  }
}
