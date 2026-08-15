// collect-report.js
// Safari Web Extension content script — diagnostics collector for bug reports.
//
// Run at document_idle. matches: the same hosts as the two nag scripts.
//
// This script changes NOTHING on the page. It registers a runtime.onMessage
// listener and, when the report popup (report.html) asks, returns a snapshot of
// the things that matter when a nag slips through: whether our content script
// actually ran, the current scroll-lock state, which nag signatures are still
// present, which pinned elements are covering the viewport that we did NOT
// recognise, which components the page preloaded, and a sanitized copy of the
// page HTML.
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
  // Measure the scroll here, on the device, instead of asking the reader to
  // describe it. See scrollTest().
  const SCROLL_TEST_MESSAGE = 'keep-scrolling:scroll-test';
  // Reload once with the nag scripts paused, so the reader can capture the same
  // page untouched. The scripts clear the flag themselves on that load.
  const BASELINE_MESSAGE = 'keep-scrolling:baseline';

  // Caps. The prefilled URL is budgeted separately and much tighter (see
  // report.js); these only stop us from moving a multi-megabyte string across
  // the message port. The HTML limit is generous because the clipboard, not
  // the URL, is what actually carries the page HTML to the issue — a snapshot
  // cut off inside <head> is not something anyone can diagnose from.
  const HTML_LIMIT = 400000;
  const SNIPPET_LIMIT = 1500;
  const ATTR_LIMIT = 400;
  const TAG_LIMIT = 300;

  // Pinned elements big enough to be "the thing covering the page".
  const OVERLAY_LIMIT = 8;
  const OVERLAY_MIN_COVERAGE = 0.1;
  const OVERLAY_SCAN_LIMIT = 8000;
  const COMPONENT_LIMIT = 60;

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
    // What the X script marked as a nag and hid. Reported so "we never matched
    // it" and "we hid it and it is still on screen" stay distinguishable.
    '[data-xnr-hidden]',
    // Links the X script rewrote, each carrying its original href. This is what
    // makes the extension's own edits separable from the site's markup in a
    // snapshot taken after it ran — otherwise the only way to tell them apart
    // is a second capture with the extension disabled.
    '[data-xnr-defused]',
    // Content placeholders that never resolved. X ends a logged-out post page
    // with `<div role="status" aria-label="Loading post">` skeletons, and a
    // page that ends in those is short — which the reader experiences as "it
    // will not scroll" even though nothing is locked (issue #28). The sample
    // shows the aria-label, so this stays useful in any language. It may also
    // catch a toast; over-matching costs nothing here, nothing is removed.
    '[role="status"]',
    // Not removal signatures for either script — the libraries X has moved its
    // logged-out prompts onto, first `vaul` and now Base UI. Reported because a
    // page locked by a prompt we have no selector for is exactly the case this
    // reporter exists for; data-base-ui-scroll-locked in particular names the
    // lock itself, which no amount of html/body inline style would reveal once
    // the nag script has already cleared it.
    '[data-vaul-drawer]',
    '[data-vaul-overlay]',
    '[data-base-ui-scroll-locked]',
    '[data-base-ui-inert]',
  ];

  // The marker stylesheets the two nag scripts inject. Their presence is proof
  // the content script ran on this page at all — the single most useful bit in
  // a "it didn't work" report, and the one thing a user cannot check.
  const SCRIPT_MARKERS = { reddit: 'rnr-style', x: 'xnr-style' };
  // Base UI marks <html> with this while its scroll lock is in force.
  const BASE_UI_LOCK_ATTR = 'data-base-ui-scroll-locked';
  const LOCK_SAMPLES = 12;
  const LOCK_GAP_MS = 40;

  function truncate(text, limit) {
    if (typeof text !== 'string' || text.length <= limit) return text || '';
    return `${text.slice(0, limit)}\n…[truncated, ${text.length} chars total]`;
  }

  // The page HTML is capped differently from everything else: it keeps BOTH
  // ends and loses the middle. A plain head-first truncation throws away the
  // end of `<body>`, which is exactly where a late-injected nag lands — the
  // report would then be capped at the one part of the document that never
  // contains what is being reported. The head is worth keeping too, for the
  // preloads and injected stylesheets that named both variants in docs/.
  function clampDocument(html, limit) {
    if (typeof html !== 'string' || html.length <= limit) return html || '';
    const head = Math.floor(limit * 0.25);
    const tail = limit - head;
    return `${html.slice(0, head)}\n…[${html.length - limit} chars cut from the middle; `
      + `${html.length} total]…\n${html.slice(html.length - tail)}`;
  }

  // Best-effort redaction. Script and style bodies go first: they are the bulk
  // of a Reddit/X page and the likeliest place for a session token to sit in an
  // inline JSON blob.
  //
  // Each pattern matches ONE tag or ONE attribute and decides inside a callback,
  // rather than chaining `[^>]*` runs across a tag — same result, no ambiguous
  // backtracking to reason about on a megabyte of hostile input.
  //
  // Two details that a naive `<\/script>` / `<tag[^>]*>` pair gets wrong, and
  // that leak the very values this function exists to remove:
  //   - browsers accept junk in an end tag (`</script >`, `</style foo>`), so a
  //     body closed that way would slip past a literal `</script>` match and be
  //     reported verbatim. CodeQL flags this as js/bad-tag-filter.
  //   - a quoted attribute value may itself contain `>` (`content="a > b"`),
  //     which ends a `[^>]*` run early and leaves the rest of the tag
  //     unredacted — hence the quote-aware attribute walk.
  function sanitizeHtml(html) {
    if (typeof html !== 'string') return '';
    const credential = /token|csrf|auth|session|secret|password|apikey|api[-_]?key|nonce/i;
    // The only <meta> tags whose content survives: they describe how the page
    // lays itself out (occasionally relevant to a nag that covers the viewport)
    // and can hold nothing user- or session-specific. Kept local to the
    // function so it stays self-contained — the tests drive it on its own.
    const keepMeta = /^(?:viewport|charset|color-scheme|theme-color|referrer|robots|generator)$/i;
    return html
      .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\b[^>]*>)/gi, '$1/*…*/$2')
      .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\b[^>]*>)/gi, '$1/*…*/$2')
      .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\b[^>]*>)/gi, '$1…$2')
      // Any attribute the site itself named after a credential.
      .replace(/\s([\w:-]+)="[^"]*"/g, (attribute, name) =>
        (credential.test(name) ? ` ${name}="…"` : attribute))
      // <meta content="…"> is redacted by DEFAULT, not just when the tag looks
      // credential-shaped. Matching on the name only ever caught the honest
      // cases (`csrf-token`): the head is also where a page parks its CSP
      // nonce, its Sentry trace/baggage ids, request ids and build hashes,
      // under names no pattern predicts. None of that helps diagnose a nag, so
      // the exchange is free — keep the handful of tags that describe the
      // page's layout and drop every other value.
      .replace(/<meta\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, (tag) => {
        const name = (tag.match(/\s(?:name|property|http-equiv|itemprop)="([^"]*)"/i) || [, ''])[1];
        return keepMeta.test(name.trim()) ? tag : tag.replace(/(\scontent=")[^"]*"/i, '$1…"');
      })
      // Values typed into the page (search box, login form).
      .replace(/<input\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, (tag) =>
        tag.replace(/(\svalue=")[^"]*"/i, '$1…"'))
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

  // `touch-action` is not inherited, but the effective value for a touch is the
  // intersection over the hit element and its ancestors — so a cover anywhere
  // in that chain can forbid vertical panning. Anything but `auto` and
  // `manipulation` has to name a vertical pan explicitly to still allow one.
  function forbidsVerticalPan(touchAction) {
    const value = String(touchAction || 'auto');
    if (value === 'auto' || value === 'manipulation') return false;
    return !/\b(?:pan-y|pan-up|pan-down)\b/.test(value);
  }

  function openingTag(el) {
    const html = el.outerHTML || '';
    const close = html.indexOf('>');
    return truncate(sanitizeHtml(close === -1 ? html : html.slice(0, close + 1)), TAG_LIMIT);
  }

  // What is actually under the reader's finger, and can it pan?
  //
  // `scrollable` below only says the document is taller than the viewport. It
  // says nothing about whether a drag moves it, and those come apart: issue #25
  // was a full-screen `touch-action: none` cover (X's app-store modal, `fixed
  // inset-0 touch-none`) over a page that reported scrollable:true,
  // overflow:visible and no lock on html or body. Every field in this report
  // said "healthy" while the page could not be panned at all — the one thing
  // the user was trying to tell us. So hit-test the middle of the viewport and
  // walk up, naming the first element in the chain that refuses a vertical pan.
  function describeTouchTarget() {
    let el;
    try { el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); }
    catch { return undefined; }
    if (!el) return undefined;

    let target;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let style;
      try { style = getComputedStyle(node); } catch { break; }
      if (!target) target = openingTag(node);
      if (forbidsVerticalPan(style.touchAction)) {
        return {
          target,
          blocked: true,
          by: openingTag(node),
          touchAction: style.touchAction,
          position: style.position,
          pointerEvents: style.pointerEvents,
        };
      }
    }
    return { target, blocked: false };
  }

  // A lock that comes and goes leaves no trace in a single reading.
  //
  // Paired captures of one post — with and without the extension — showed X
  // escalating: without us it renders the `<aside>` banner and the page
  // scrolls; with us it renders the touch-none `app-store-obstruction` modal
  // instead. Our stylesheet hides that modal and releaseScroll() clears the
  // lock its library applies, and every snapshot taken afterwards reads clean.
  // If the page is nevertheless frozen for the reader, the interesting thing is
  // not the state at one instant but whether it is *changing* — a lock applied
  // and released repeatedly looks identical to no lock at all in one sample.
  function watchLock(samples, gapMs) {
    const read = () => {
      const html = document.documentElement;
      const body = document.body;
      let cover = '';
      try {
        const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const st = getComputedStyle(n);
          if (forbidsVerticalPan(st.touchAction)) { cover = st.touchAction; break; }
        }
      } catch { /* ignore */ }
      return [
        html ? html.getAttribute('style') || '' : '',
        body ? body.getAttribute('style') || '' : '',
        html && html.hasAttribute(BASE_UI_LOCK_ATTR) ? 'base-ui-locked' : '',
        cover,
      ].join('|');
    };
    return new Promise((resolve) => {
      const seen = [];
      let n = 0;
      const tick = () => {
        const state = read();
        if (seen[seen.length - 1] !== state) seen.push(state);
        n += 1;
        if (n >= samples) resolve(seen);
        else setTimeout(tick, gapMs);
      };
      tick();
    });
  }

  // Try to scroll the page and report what happened.
  //
  // Every report so far has had to travel through a sentence — "the page will
  // not scroll" — and three of them arrived with every collected field saying
  // the page was fine. The reader was right each time and the snapshot could
  // not show it, because a snapshot is a state and this is a behaviour.
  //
  // So: measure it where it happens. Scroll, read back, and say how far it
  // actually went, what refused it, and how much page there was to move. That
  // is the same set of numbers the headless harness prints, taken on the engine
  // that matters at the moment it is broken — which is the difference between a
  // report we can act on and an hour of forensics.
  //
  // A caveat kept in the output rather than hidden: this is a programmatic
  // scroll, so `touch-action` does not apply to it the way it applies to a
  // finger. `blockedBy` is what covers that gap — it names the element whose
  // computed touch-action forbids a vertical pan, which is the thing a
  // programmatic scroll would sail straight past.
  function scrollTest() {
    const scroller = document.scrollingElement;
    if (!scroller) return { error: 'no scrolling element' };
    const viewport = window.innerHeight;
    const started = window.scrollY;
    const maxScroll = Math.max(0, Math.round(scroller.scrollHeight - viewport));

    // Aim for most of a screen, which is what a flick is worth, and never past
    // the end — asking for more than exists would look like a failure to move.
    const target = Math.min(started + Math.round(viewport * 0.75), maxScroll);
    let moved = 0;
    try {
      window.scrollTo(0, target);
      moved = Math.round(window.scrollY - started);
      window.scrollTo(0, started);
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }

    const pan = describeTouchTarget();
    return {
      moved,
      asked: target - started,
      maxScroll,
      screens: viewport ? Math.round((scroller.scrollHeight / viewport) * 10) / 10 : 0,
      startedAt: Math.round(started),
      // What the numbers mean, decided here so the issue does not have to be
      // interpreted by whoever reads it.
      verdict: verdictFor(moved, target - started, maxScroll, pan),
      blockedBy: pan && pan.blocked ? pan.by : undefined,
      touchAction: pan && pan.blocked ? pan.touchAction : undefined,
    };
  }

  function verdictFor(moved, asked, maxScroll, pan) {
    if (pan && pan.blocked) return 'something over the page refuses a vertical drag';
    if (maxScroll <= 4) return 'there is no page to scroll — the document is not taller than the screen';
    if (asked > 4 && moved <= 4) return 'the page refused to scroll at all';
    if (asked > 4 && moved < asked - 4) return 'the page scrolled less than it was asked to';
    if (maxScroll < window.innerHeight) return 'the page scrolls, but there is less than one screen of it';
    return 'the page scrolled normally';
  }

  function describeEdits() {
    const style = document.getElementById(SCRIPT_MARKERS.x)
      || document.getElementById(SCRIPT_MARKERS.reddit);
    let hidden = 0;
    let defused = 0;
    try { hidden = document.querySelectorAll('[data-xnr-hidden]').length; } catch { /* ignore */ }
    try { defused = document.querySelectorAll('[data-xnr-defused]').length; } catch { /* ignore */ }
    return {
      hidden,
      defused,
      locksReleased: style ? Number(style.getAttribute('data-xnr-releases') || 0) : 0,
      lastLock: (style && style.getAttribute('data-xnr-last-lock')) || undefined,
    };
  }

  // The half of the problem a user can actually feel: is the page frozen?
  function describeScrollLock() {
    const scroller = document.scrollingElement;
    const viewport = window.innerHeight;
    const height = scroller ? scroller.scrollHeight : 0;
    // How far the page can travel at all, not just whether it can move.
    // `scrollable` is satisfied by 4px, and issue #28 was a page with 590px of
    // scroll in it: the extension had already released everything there was to
    // release, the reader flicked, the page moved two thirds of a screen and
    // stopped against reply placeholders that never filled in. That is
    // indistinguishable from a lock in a boolean, and obvious in a distance.
    return {
      elements: [
        describeElement('html', document.documentElement),
        describeElement('body', document.body),
      ],
      scrollable: !!scroller && height - viewport > 4,
      maxScroll: Math.max(0, Math.round(height - viewport)),
      screens: viewport ? Math.round((height / viewport) * 10) / 10 : 0,
      pan: describeTouchTarget(),
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

  // Every nag either script has had to remove — Reddit's blocking bottom
  // sheet, X's app-store modal, X's vaul drawer — is a pinned element covering
  // a good part of the viewport. Listing the pinned elements we did NOT
  // recognise is what turns "the whole page is covered by something" into an
  // actionable report: it names the unknown variant even when the page HTML is
  // too big to travel with the issue.
  function collectOverlays() {
    const found = [];
    const area = window.innerWidth * window.innerHeight;
    if (!document.body || !area) return found;
    let nodes;
    try { nodes = document.body.querySelectorAll('*'); } catch { return found; }

    const scanned = Math.min(nodes.length, OVERLAY_SCAN_LIMIT);
    for (let i = 0; i < scanned; i += 1) {
      const el = nodes[i];
      let style;
      try { style = getComputedStyle(el); } catch { continue; }
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      let rect;
      try { rect = el.getBoundingClientRect(); } catch { continue; }
      const coverage = (rect.width * rect.height) / area;
      if (coverage < OVERLAY_MIN_COVERAGE) continue;

      // The opening tag alone: id, classes and any data-* the site named the
      // component after (`data-interaction`, `data-vaul-drawer`) — the parts a
      // new selector would be built from, without the subtree's bulk.
      found.push({
        coverage: Math.round(coverage * 100) / 100,
        position: style.position,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        touchAction: style.touchAction,
        tag: openingTag(el),
        text: truncate((el.textContent || '').replace(/\s+/g, ' ').trim(), 200),
      });
    }

    found.sort((a, b) => b.coverage - a.coverage);
    return found.slice(0, OVERLAY_LIMIT);
  }

  // The module names a page preloads are how both diagnoses in docs/ actually
  // started: `logged-out-open-app-banner-*.js` named the banner component and
  // `vaul`'s drawer stylesheet named the scroll lock, before either was
  // matched in the DOM. They are a few hundred bytes, so they survive into the
  // issue even when the page HTML does not.
  function collectComponents() {
    const names = new Set();
    let nodes;
    try {
      nodes = document.querySelectorAll(
        'link[rel="modulepreload"][href], link[rel="preload"][as="script"][href], script[src]',
      );
    } catch { return []; }

    for (const node of nodes) {
      const url = node.getAttribute('href') || node.getAttribute('src') || '';
      const file = url.split(/[?#]/)[0].split('/').pop() || '';
      // `logged-out-open-app-banner-D4f8Xq2b.js` → `logged-out-open-app-banner`:
      // drop the extension, then the content hash, so the same component does
      // not read as a new one on every deploy.
      const name = file.replace(/\.[a-z]+$/i, '').replace(/[-.][A-Za-z0-9_]{8,}$/, '');
      if (name) names.add(name);
      if (names.size >= COMPONENT_LIMIT) break;
    }
    return [...names];
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
      // What the nag scripts did to this page, straight from the markers they
      // leave: how many locks were released and what shape the last one was.
      // A released lock leaves as little trace as a lock that never existed, so
      // without this "we fixed it" and "there was nothing there" are the same
      // report.
      edits: describeEdits(),
      scriptsActive: {
        reddit: !!document.getElementById(SCRIPT_MARKERS.reddit),
        x: !!document.getElementById(SCRIPT_MARKERS.x),
      },
      lock: describeScrollLock(),
      signatures: collectSignatures(),
      overlays: collectOverlays(),
      components: collectComponents(),
      html: clampDocument(sanitizeHtml(root ? root.outerHTML : ''), HTML_LIMIT),
    };
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === BASELINE_MESSAGE) {
      // The one thing in this file that is not read-only, and it is deliberate:
      // it changes no markup, only asks for the next load to skip the nag
      // scripts. Answer first, then reload — the reply cannot survive it.
      try {
        sessionStorage.setItem('keep-scrolling:pause-once', '1');
        sendResponse({ ok: true });
        setTimeout(() => { location.reload(); }, 0);
      } catch (error) {
        sendResponse({ error: String((error && error.message) || error) });
      }
      return true;
    }
    if (message && message.type === SCROLL_TEST_MESSAGE) {
      try { sendResponse(scrollTest()); }
      catch (error) { sendResponse({ error: String((error && error.message) || error) }); }
      return true;
    }
    if (!message || message.type !== COLLECT_MESSAGE) return undefined;
    // The lock watch is the one part that cannot be read instantly: half a
    // second of sampling is what separates "nothing is locked" from "something
    // locks and unlocks faster than a snapshot can see".
    watchLock(LOCK_SAMPLES, LOCK_GAP_MS).then((states) => {
      try {
        const snapshot = collect();
        if (snapshot.lock) {
          snapshot.lock.states = states.length;
          // Only worth the space when it actually changed; one steady state is
          // the normal case and says nothing a single reading did not.
          if (states.length > 1) snapshot.lock.changed = states.map((s) => truncate(s, ATTR_LIMIT));
        }
        sendResponse(snapshot);
      } catch (error) {
        sendResponse({ error: String((error && error.message) || error) });
      }
    }, (error) => sendResponse({ error: String((error && error.message) || error) }));
    // Answered asynchronously; `true` keeps the channel open for the reply.
    return true;
  });
})();
