// collect-report.js
// Safari Web Extension content script — diagnostics collector for bug reports.
//
// Run at document_idle. matches: the same hosts as the two nag scripts.
//
// This script changes NOTHING on the page. It registers a runtime.onMessage
// listener and, when the report popup (report.html) asks, returns a snapshot of
// the things that matter when a nag slips through: whether our content script
// actually ran, the current scroll-lock state, which nag signatures are still
// present, and a sanitized copy of the page HTML.
//
// Design notes:
//  - Deliberately separate from block-reddit-nag.js / block-x-nag.js. Those two
//    are the product and are kept minimal and independent of each other; a
//    diagnostics reader has no business inside either of them, and a bug in it
//    must not be able to take the nag removal down with it.
//  - The snapshot is taken AFTER the nag scripts have run, so a healthy report
//    normally shows zero signature matches. That is the point: `scriptsActive`
//    plus an empty signature list distinguishes "the extension never ran" from
//    "it ran and the nag is a new variant it does not recognize".
//  - Nothing is transmitted from here. The reply goes to the extension's own
//    popup, which shows the user the exact text and lets them edit it before
//    they open a prefilled GitHub issue by hand.
//  - sanitizeHtml() is a best-effort redaction pass, not a security boundary:
//    the page HTML of a logged-in session inevitably contains that session's
//    content. The popup says so, and shows the report before anything leaves
//    the device.

(() => {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.onMessage) return;

  const COLLECT_MESSAGE = 'keep-scrolling:collect';

  // Caps. The popup trims further to fit a prefilled URL; these just stop us
  // from moving a multi-megabyte string across the message port.
  const HTML_LIMIT = 120000;
  const SNIPPET_LIMIT = 1500;
  const ATTR_LIMIT = 400;

  // Union of both nag scripts' signatures, used read-only for reporting. Over-
  // matching here is harmless (nothing is removed), so it also includes the
  // bare launch_app_store markers that the X script only rewrites.
  const SIGNATURES = [
    'rpl-bottom-sheet[blocking]',
    '[id*="app-upsell-blocking"]',
    '[id*="contextual-app-upsell"]',
    'faceplate-loader[name^="AppUpsellBlocking"]',
    '[data-interaction^="app-store-obstruction"]',
    'a[download][href*="launch_app_store=true"]',
    '[href*="launch_app_store=true"]',
    '[data-href*="launch_app_store=true"]',
  ];

  // The marker stylesheets the two nag scripts inject. Their presence is proof
  // the content script ran on this page at all — the single most useful bit in
  // a "it didn't work" report, and the one thing a user cannot check.
  const SCRIPT_MARKERS = { reddit: 'rnr-style', x: 'xnr-style' };

  function truncate(text, limit) {
    if (typeof text !== 'string' || text.length <= limit) return text || '';
    return `${text.slice(0, limit)}\n…[truncated, ${text.length} chars total]`;
  }

  // Best-effort redaction. Script and style bodies go first: they are the bulk
  // of a Reddit/X page and the likeliest place for a session token to sit in an
  // inline JSON blob.
  //
  // Each pattern matches ONE tag or ONE attribute and decides inside a callback,
  // rather than chaining `[^>]*` runs across a tag — same result, no ambiguous
  // backtracking to reason about on a megabyte of hostile input.
  function sanitizeHtml(html) {
    if (typeof html !== 'string') return '';
    const credential = /token|csrf|auth|session|secret|password|apikey|api[-_]?key/i;
    return html
      .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1/*…*/$2')
      .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1/*…*/$2')
      .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, '$1…$2')
      // Any attribute the site itself named after a credential.
      .replace(/\s([\w:-]+)="[^"]*"/g, (attribute, name) =>
        (credential.test(name) ? ` ${name}="…"` : attribute))
      // <meta name="csrf-token" content="…">, where the credential-shaped name
      // is on one attribute and the value on another (in either order).
      .replace(/<meta\b[^>]*>/gi, (tag) =>
        (credential.test(tag) ? tag.replace(/(\scontent=")[^"]*"/i, '$1…"') : tag))
      // Values typed into the page (search box, login form).
      .replace(/<input\b[^>]*>/gi, (tag) => tag.replace(/(\svalue=")[^"]*"/i, '$1…"'))
      // Inline images and fonts: enormous, never diagnostic.
      .replace(/((?:src|href)=")data:[^"]{64,}"/gi, '$1data:…"');
  }

  function describeElement(name, el) {
    if (!el) return { element: name, present: false };
    let computed = {};
    try {
      const style = getComputedStyle(el);
      computed = {
        overflow: style.overflow,
        position: style.position,
        touchAction: style.touchAction,
        pointerEvents: style.pointerEvents,
      };
    } catch { /* getComputedStyle can fail on a detached document */ }
    return {
      element: name,
      present: true,
      class: truncate(el.getAttribute('class') || '', ATTR_LIMIT),
      style: truncate(el.getAttribute('style') || '', ATTR_LIMIT),
      computed,
    };
  }

  // The half of the problem a user can actually feel: is the page frozen?
  function describeScrollLock() {
    const scroller = document.scrollingElement;
    return {
      elements: [
        describeElement('html', document.documentElement),
        describeElement('body', document.body),
      ],
      scrollable: !!scroller && scroller.scrollHeight - window.innerHeight > 4,
    };
  }

  function collectSignatures() {
    const found = [];
    for (const selector of SIGNATURES) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      if (!nodes.length) continue;
      found.push({
        selector,
        count: nodes.length,
        sample: truncate(sanitizeHtml(nodes[0].outerHTML), SNIPPET_LIMIT),
      });
    }
    return found;
  }

  function collect() {
    const root = document.documentElement;
    return {
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      readyState: document.readyState,
      scriptsActive: {
        reddit: !!document.getElementById(SCRIPT_MARKERS.reddit),
        x: !!document.getElementById(SCRIPT_MARKERS.x),
      },
      lock: describeScrollLock(),
      signatures: collectSignatures(),
      html: truncate(sanitizeHtml(root ? root.outerHTML : ''), HTML_LIMIT),
    };
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== COLLECT_MESSAGE) return undefined;
    try {
      sendResponse(collect());
    } catch (error) {
      sendResponse({ error: String((error && error.message) || error) });
    }
    // Answered synchronously above; `true` keeps the channel valid across the
    // callback- and promise-flavoured runtime implementations alike.
    return true;
  });
})();
