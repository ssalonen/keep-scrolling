// block-x-nag.js
// Safari Web Extension content script.
// Neutralizes X/Twitter's logged-out app-install nags — the "Open X App"
// banner/pill and the blocking "See this post in the app" modal — and restores
// scrolling on mobile Safari.
//
// Run at document_start. matches: *://*.x.com/*, *://*.twitter.com/*
//
// Design notes:
//  - The nags are matched by X's own semantic markers, never by the Tailwind
//    utility classes around them (cosmetic, retouch-prone): the
//    `launch_app_store=true` query param plus the `ct=` surface name on the
//    link, and `data-interaction="app-store-obstruction"` on the modal.
//  - Deliberately does NOT match on <aside> alone or any generic
//    role="region" selector — the page also renders an unrelated,
//    legally-required cookie-consent banner
//    (div[role="region"][aria-label="Cookie consent"]) that must never be
//    touched.
//  - Nags are HIDDEN, not removed. X now server-renders the blocking modal, so
//    ripping it out of the DOM at document_start deletes a node React is about
//    to hydrate against; the reply list comes back as permanent "Loading post"
//    skeletons and the post page ends after three replies, which is what a
//    reader experiences as "the page will not scroll". Marking the node with
//    data-xnr-hidden and hiding it from our own stylesheet is invisible to
//    React, leaves X's own dismiss/unlock path working, and cannot take
//    surrounding content with it.
//  - The scroll lock has never had a class of its own like Reddit's; it is a
//    set of *inline* styles, and it has now had three shapes across three X
//    builds (bare overflow:hidden, `vaul`'s position:fixed, Base UI's
//    two paths). releaseScroll() undoes all of them and runs on every pass
//    rather than only when a nag was matched: a lock we cannot attribute to a
//    nag we recognise is exactly the case that leaves the page frozen with
//    nothing on screen to explain it.
//  - Separately, logged-out engagement controls (Reply/Repost/Like/Bookmark,
//    and the whole-row tap target on a reply) are wired to
//    "https://m.x.com/...?launch_app_store=true&ct=engagement_*" — tapping
//    ANY of them, not just the banner, forces the app-install bounce. Those
//    are controls the reader meant to tap, so they are never hidden: instead
//    just the launch_app_store=true param is stripped (leaving the rest of the
//    URL, e.g. ct=engagement_reply, intact) so the tap navigates normally.

(() => {
  'use strict';

  const APP_STORE_MARKER = 'launch_app_store=true';
  const APP_STORE_LINK_SELECTOR = 'a[href*="launch_app_store=true"]';
  const APP_STORE_HREF_SELECTOR =
    '[href*="launch_app_store=true"], [data-href*="launch_app_store=true"]';
  // Prefix-matched so a renamed root (…-obstruction-dialog) is still caught,
  // and so the -backdrop / -panel children (and a renamed root) stay covered by
  // the CSS backstop. Everything X names "app-store-obstruction" IS the
  // app-install nag, so this cannot over-match the way a bare [role="dialog"]
  // would (that would also catch the verified badge popover, the share menu,
  // etc.).
  const APP_OBSTRUCTION_SELECTOR = '[data-interaction^="app-store-obstruction"]';
  // Our own mark. Hiding through a data attribute + our stylesheet (rather than
  // an inline style) keeps the hide out of anything React manages, so a
  // re-render does not undo it and does not fight us over the style attribute.
  const HIDDEN_ATTR = 'data-xnr-hidden';
  const HIDDEN_SELECTOR = '[data-xnr-hidden]';
  // Base UI's own marker for "this document is scroll-locked". X moved its
  // logged-out prompts from `vaul` onto Base UI, whose lock is a different
  // shape again — see releaseBaseUiLock().
  const BASE_UI_LOCK_ATTR = 'data-base-ui-scroll-locked';

  // --- Undo Base UI's scroll lock --------------------------------------------
  // Base UI (the popup library behind X's current logged-out prompts) locks in
  // one of two ways. On mobile Safari, where there is no scrollbar to
  // compensate for, it just sets inline overflow-x/overflow-y:hidden — handled
  // by releaseScroll() below. Otherwise it moves the scroll onto <body>:
  // <html> gets scrollbar-gutter/overflow/scroll-behavior and this attribute,
  // and <body> becomes a position:relative, 100dvh × 100vw, border-box box
  // with the reader's offset parked in body.scrollTop. Clearing overflow alone
  // leaves the body clamped to a single viewport — released, but still
  // unscrollable — so the whole set has to come off together, and the offset
  // has to be read back *before* it does.
  function releaseBaseUiLock() {
    const html = document.documentElement;
    const body = document.body;
    if (!html || !html.hasAttribute || !html.hasAttribute(BASE_UI_LOCK_ATTR)) return;

    const offset = body ? body.scrollTop : 0;
    if (body && body.style) {
      for (const prop of [
        'position', 'height', 'width', 'box-sizing',
        'overflow-y', 'overflow-x', 'scroll-behavior',
      ]) {
        body.style.removeProperty(prop);
      }
    }
    if (html.style) {
      for (const prop of ['scrollbar-gutter', 'overflow-y', 'overflow-x', 'scroll-behavior']) {
        html.style.removeProperty(prop);
      }
    }
    html.removeAttribute(BASE_UI_LOCK_ATTR);
    if (offset > 0) {
      try { window.scrollTo(0, offset); } catch { /* ignore */ }
    }
  }

  // --- Release the page scroll (inline lock styles only) ---------------------
  // Only ever clears *inline* values, so a stylesheet-driven overflow rule
  // (i.e. the page's own layout) is left alone.
  function releaseScroll() {
    // First, because it reads back a scroll offset that clearing the inline
    // overflow below would reset to 0.
    releaseBaseUiLock();

    for (const el of [document.documentElement, document.body]) {
      if (!el || !el.style) continue;
      const s = el.style;

      // 1. The original lock: style="overflow: hidden".
      if (s.overflow === 'hidden') s.overflow = '';
      if (s.overflowY === 'hidden') s.overflowY = '';
      // Base UI's mobile path sets both axes. overflow-x on its own does not
      // freeze the page, but leaving it behind clips the layout sideways.
      if (s.overflowX === 'hidden') s.overflowX = '';

      // 2. The `vaul` drawer lock. X shipped that library for a while and it
      //    pins the page with position:fixed !important plus top/left/right/
      //    height, keeping the scroll offset in a negative `top`. Undo the
      //    whole set together and scroll back to where the user was — dropping
      //    `position` on its own teleports them to the top.
      if (s.position === 'fixed') {
        const offset = parseInt(s.top, 10);
        for (const prop of ['position', 'top', 'left', 'right', 'width', 'height']) {
          s.removeProperty(prop);
        }
        if (Number.isFinite(offset) && offset < 0) {
          try { window.scrollTo(0, -offset); } catch { /* ignore */ }
        }
      }

      // 3. The blocking modal's lock also disables interaction with everything
      //    behind it via an inline pointer-events:none — clear only that exact
      //    inline value, never a stylesheet-driven one. An inline
      //    touch-action:none is the same idea aimed straight at panning: it
      //    freezes the page with nothing to see in `overflow` at all, which is
      //    the shape issue #25 turned out to have (there, on the modal rather
      //    than on <body> — but if X ever moves it here, overflow-watching
      //    would miss it completely).
      if (s.pointerEvents === 'none') s.pointerEvents = '';
      if (s.touchAction === 'none') s.touchAction = '';
      s.removeProperty('padding-right');
    }
  }

  // --- Is this app-store link a nag, or a control the reader tapped? ---------
  // X tags every app-store link with a `ct` naming the surface it sits on.
  // ct=engagement_* is an engagement control — Reply, Repost, Like, Bookmark,
  // the whole-row tap target on a reply — which the reader went looking for and
  // which must stay exactly where it is; those are handled by
  // defuseAppStoreLinks() instead. Every other value is a standalone
  // "get the app" affordance: ct=post-modal is the blocking modal's CTA,
  // ct=post-timeline the bottom banner, and the top-bar "Open app" pill carries
  // no ct at all.
  function isNagLink(url) {
    const ct = /[?&]ct=([^&#]*)/.exec(url || '');
    return !ct || !ct[1].startsWith('engagement');
  }

  // --- Hide any nags currently in the DOM ------------------------------------
  function hide(el) {
    if (!el || !el.setAttribute || el.hasAttribute(HIDDEN_ATTR)) return false;
    el.setAttribute(HIDDEN_ATTR, '');
    return true;
  }

  function hideNags() {
    let hit = false;
    let anchors;
    try { anchors = document.querySelectorAll(APP_STORE_LINK_SELECTOR); } catch { anchors = []; }
    for (const a of anchors) {
      if (!isNagLink(a.getAttribute('href'))) continue;
      // Only take the whole <aside> ancestor when it's actually the floating
      // banner (position: fixed, matching the observed markup) — an in-flow
      // <aside> could be something else entirely (e.g. a reply-list region
      // whose pagination sentinel we'd hide along with it), so fall back to
      // hiding just the anchor rather than guessing.
      const aside = a.closest('aside');
      const host = aside && getComputedStyle(aside).position === 'fixed' ? aside : a;
      if (hide(host)) hit = true;
    }

    // The blocking "See this post in the app" modal is hidden by the injected
    // stylesheet alone — see injectStyle(). It is server-rendered, so it is on
    // screen before any script of ours runs and needs a rule that does not wait
    // for a pass; and marking it here would gain nothing the rule does not
    // already do.

    // Always re-assert scroll, like the Reddit script does. This used to be
    // gated on `hit`, on the theory that X reuses the inline overflow:hidden
    // idiom for legitimate modals we shouldn't fight. On-device that gate is
    // what breaks: X locks the page from prompts that carry none of the
    // markers above, so `hit` stays false and the page stays frozen with no
    // nag on screen. A background that scrolls behind an open share sheet is a
    // far cheaper failure than a page that cannot scroll at all.
    releaseScroll();
    return hit;
  }

  // --- Strip the app-store-bounce param from engagement links/rows -----------
  function stripAppStoreParam(url) {
    return url
      .replace(/([?&])launch_app_store=true&?/, '$1')
      .replace(/[?&]$/, '');
  }

  function defuseAppStoreLinks() {
    let hit = false;
    let els;
    try { els = document.querySelectorAll(APP_STORE_HREF_SELECTOR); } catch { els = []; }
    for (const el of els) {
      for (const attr of ['href', 'data-href']) {
        const val = el.getAttribute(attr);
        if (val && val.includes(APP_STORE_MARKER)) {
          el.setAttribute(attr, stripAppStoreParam(val));
          hit = true;
        }
      }
    }
    return hit;
  }

  // --- Inject a race-free CSS backstop ----------------------------------------
  function injectStyle() {
    // At document_start there may be no document element yet to append to.
    // Bail out instead of throwing: an exception here would propagate out of
    // the first run() call and abort the whole script *before* the observer
    // below is installed, leaving the page unprotected for good. Every later
    // pass calls this again, so the style still lands as soon as there is
    // somewhere to put it.
    const root = document.head || document.documentElement;
    if (!root || document.getElementById('xnr-style')) return;
    const style = document.createElement('style');
    style.id = 'xnr-style';
    style.textContent =
      // What hideNags() marked. A plain attribute match — no :has() — so this
      // works below iOS 16.4 too, unlike the aside:has(...) rule it replaced.
      `${HIDDEN_SELECTOR} { display: none !important; }\n` +
      // The blocking modal, hidden from the first paint. X server-renders it,
      // so a rule is the only thing that can beat it to the screen; and since
      // the rule stands on its own, the node itself is left for React.
      `${APP_OBSTRUCTION_SELECTOR} { display: none !important; }\n` +
      `body:has(${APP_OBSTRUCTION_SELECTOR}) { overflow: auto !important; }`;
    root.appendChild(style);
  }

  // --- Debounced runner driven by the observer --------------------------------
  let queued = false;
  function run() {
    queued = false;
    injectStyle();
    // hideNags() before defuseAppStoreLinks(): the marker it matches on is the
    // very param defuseAppStoreLinks() strips. The hide survives regardless —
    // it is recorded on the node, not re-derived from the href each pass — but
    // the order is what lets a freshly rendered nag be recognised at all.
    hideNags();
    defuseAppStoreLinks();
  }
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(run);
  }

  // First pass as early as possible.
  run();

  // Watch for lazy injection of the banner and for scroll-lock re-application.
  const observer = new MutationObserver(schedule);
  function startObserver() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('readystatechange', startObserver, { once: true });

  // Re-assert on load milestones.
  for (const ev of ['DOMContentLoaded', 'load']) {
    window.addEventListener(ev, schedule, { once: true });
  }
})();
