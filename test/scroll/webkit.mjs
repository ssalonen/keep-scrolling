// webkit.mjs — measure a page in the engine iPhones actually run.
//
// The pan harness drives Chromium, because only Chromium exposes a way to
// synthesize a *trusted* touch drag (CDP `Input.dispatchTouchEvent`).
// Playwright's WebKit offers taps and no swipe, so it cannot answer "does a
// finger move this page".
//
// It can answer the other half, and that half is engine-sensitive: layout,
// computed styles, how much scroll the document actually gives up, and whether
// any content is laid out below everything the reader can reach. Safari and
// Chromium disagree about `100dvh` under a collapsing toolbar, about
// `-webkit-overflow-scrolling`, and about overflow propagation from <body> —
// all of which decide whether the last screenful is reachable.
//
// Optional by design: this is the one part of the harness that needs an npm
// install, so it is loaded dynamically and skipped when absent.
//
//   npm i playwright-core
//   npx playwright install webkit
//   npx playwright install-deps webkit   # the step that actually blocks: the
//                                        # download succeeds and then fails
//                                        # validation on missing system libs
//                                        # (libwoff2, libgstreamer, libenchant,
//                                        # libmanette, …). Needs root/apt.

import { REACH_PROBE } from './harness.mjs';

const VIEWPORT = { width: 440, height: 796 };

export async function webkitAvailable() {
  try {
    const { webkit } = await import('playwright-core');
    return !!webkit.executablePath();
  } catch { return false; }
}

/**
 * Load a page in WebKit and report what the reader can and cannot reach.
 * @param {{url: string, inject?: string, allowOrigin?: string, settle?: number}} opts
 */
export async function reachTest({ url, inject, allowOrigin, settle = 600 }) {
  const { webkit } = await import('playwright-core');
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, deviceScaleFactor: 3 });
    await context.route('**/*', (route) => {
      const target = route.request().url();
      const local = target.startsWith('file://') || target.startsWith('data:')
        || (allowOrigin && target.startsWith(allowOrigin));
      return local ? route.continue() : route.abort();
    });
    if (inject) await context.addInitScript(inject);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(settle);
    return await page.evaluate(REACH_PROBE);
  } finally {
    await browser.close();
  }
}
