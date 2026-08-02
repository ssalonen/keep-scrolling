// block-x-nag.js
// Safari Web Extension content script.
// Removes X/Twitter's logged-out "Open X App" bottom banner (component
// internally named "logged-out-open-app-banner") and restores scrolling on
// mobile Safari.
//
// Run at document_start. matches: *://*.x.com/*, *://*.twitter.com/*
//
// Design notes:
//  - The nag is a fixed <aside> banner containing
//    <a download href="...?launch_app_store=true...">Open X App</a>. The
//    href query param + download attribute are purpose-built markers, not
//    rotating hashes, so we match on those rather than the Tailwind utility
//    classes wrapping the banner.
//  - Deliberately does NOT match on <aside> alone or any generic
//    role="region" selector — the page also renders an unrelated,
//    legally-required cookie-consent banner
//    (div[role="region"][aria-label="Cookie consent"]) that must never be
//    touched.
//  - The observed scroll lock is an *inline* style="overflow:hidden" on
//    <body> (no dedicated lock class like Reddit's). releaseScroll() only
//    runs when the banner itself was found this pass, so we don't fight
//    unrelated X UI (compose box, image viewer, etc.) that may reuse the
//    same inline-style lock idiom.
//  - X also ships a *blocking* variant: a full-screen modal titled "See this
//    post in the app" (role="dialog" aria-modal, `fixed inset-0 touch-none`)
//    that covers the page and swallows touches, so the page cannot be scrolled
//    even though the <aside> banner is gone. It carries no launch_app_store
//    link at all — its marker is data-interaction="app-store-obstruction" on
//    the dialog root (with -backdrop / -panel children). That attribute is
//    X's own semantic name for the thing, so it is matched like the banner's
//    markers: by purpose, not by the Tailwind classes around it.
//  - Separately, logged-out engagement controls (Reply/Repost/Like/Bookmark,
//    and the whole-row tap target on a reply) are wired to
//    "https://m.x.com/...?launch_app_store=true&ct=engagement_*" — tapping
//    ANY of them, not just the banner, forces the app-install bounce. These
//    links have no `download` attribute, so they're a separate mechanism
//    from the banner and need their own handling.
//  - IMPORTANT: stripping launch_app_store=true is NOT enough. An on-device
//    snapshot showed every engagement link already stripped by this script
//    and the tap STILL landed on the App Store — the bounce lives on the
//    m.x.com host itself, not in the query param. m.x.com/<path> and
//    x.com/<path> address the same post, so the fix is to swap the host and
//    keep everything else (path, ct=engagement_* analytics param) intact.
//  - Because attribute rewriting is debounced behind requestAnimationFrame —
//    and because X may hold the original URL in its own JS state rather than
//    reading the attribute back — a capture-phase click handler is the
//    deterministic half of the fix: for a bounce link (and only for one) it
//    cancels X's handling and navigates to the rewritten URL itself.

(() => {
  'use strict';

  const APP_BANNER_LINK_SELECTOR = 'a[download][href*="launch_app_store=true"]';
  const APP_BANNER_CSS_SELECTOR = `aside:has(${APP_BANNER_LINK_SELECTOR})`;
  // Two independent markers for the same thing, because a link can carry
  // either: X's explicit launch_app_store=true flag, and the m./mobile. host
  // that bounces on its own. Kept as literal substrings so the selector is
  // greppable; a loose match here costs nothing, since defuseAppStoreUrl()
  // below re-checks the host precisely and leaves anything else untouched.
  const APP_STORE_HREF_SELECTOR =
    '[href*="launch_app_store=true"], [data-href*="launch_app_store=true"], ' +
    '[href*="//m.x.com"], [data-href*="//m.x.com"], ' +
    '[href*="//mobile.x.com"], [data-href*="//mobile.x.com"], ' +
    '[href*="//m.twitter.com"], [data-href*="//m.twitter.com"], ' +
    '[href*="//mobile.twitter.com"], [data-href*="//mobile.twitter.com"]';
  // Prefix-matched so a renamed root (…-obstruction-dialog) is still caught,
  // and so the -backdrop / -panel children are covered by the CSS backstop
  // even if the root itself is ever restructured. Everything X names
  // "app-store-obstruction" IS the app-install nag, so this cannot over-match
  // the way a bare [role="dialog"] would (that would also catch the verified
  // badge popover, the share menu, etc.).
  const APP_OBSTRUCTION_SELECTOR = '[data-interaction^="app-store-obstruction"]';

  // --- Release the page scroll (inline overflow/pointer-events only) ---------
  function releaseScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el || !el.style) continue;
      if (el.style.overflow === 'hidden') el.style.overflow = '';
      // The modal's scroll lock also disables interaction with everything
      // behind it via an inline pointer-events:none — clear only that exact
      // inline value, never a stylesheet-driven one.
      if (el.style.pointerEvents === 'none') el.style.pointerEvents = '';
      el.style.removeProperty('padding-right');
    }
  }

  // --- Remove any nag banners currently in the DOM ----------------------------
  function killNags() {
    let hit = false;
    let anchors;
    try { anchors = document.querySelectorAll(APP_BANNER_LINK_SELECTOR); } catch { anchors = []; }
    for (const a of anchors) {
      // Only take the whole <aside> ancestor when it's actually the floating
      // banner (position: fixed, matching the observed markup) — an in-flow
      // <aside> could be something else entirely (e.g. a reply-list region
      // whose pagination sentinel we'd delete along with it), so fall back to
      // removing just the anchor rather than guessing.
      const aside = a.closest('aside');
      const host = aside && getComputedStyle(aside).position === 'fixed' ? aside : a;
      host.remove();
      hit = true;
    }

    // The blocking "See this post in the app" modal. Removing the dialog root
    // takes its backdrop and panel with it; the children are skipped by the
    // isConnected check rather than removed twice.
    let obstructions;
    try { obstructions = document.querySelectorAll(APP_OBSTRUCTION_SELECTOR); } catch { obstructions = []; }
    for (const el of obstructions) {
      if (!el.isConnected) continue;
      el.remove();
      hit = true;
    }

    // Only release scroll when we actually found a nag (banner or blocking
    // modal): X reuses plain inline overflow:hidden for unrelated modals, and
    // we don't want to fight those.
    if (hit) releaseScroll();
    return hit;
  }

  // --- Strip the app-store-bounce param from engagement links/rows -----------
  function stripAppStoreParam(url) {
    return url
      .replace(/([?&])launch_app_store=true&?/, '$1')
      .replace(/[?&]$/, '');
  }

  // m.x.com/<path> and x.com/<path> address the same post — only the host
  // differs — so swapping it drops the App Store bounce without changing
  // where the tap goes. Anchored at the start and followed by a path/query/
  // fragment boundary so nothing else in the URL can be rewritten by accident.
  function demobilizeHost(url) {
    return url.replace(
      /^(https?:\/\/)(?:m|mobile)\.(x|twitter)\.com(?=[/?#]|$)/i,
      '$1$2.com',
    );
  }

  // Both defusals, in one place: every caller wants the same transformation,
  // and a URL that is neither flagged nor mobile-hosted comes back identical
  // (that identity is what tells the click handler to keep its hands off).
  function defuseAppStoreUrl(url) {
    return demobilizeHost(stripAppStoreParam(url));
  }

  // Rewritten tap-targets that have NO native navigation to hand back to: a
  // <div role="link" data-href> (a reply row, a quoted post) only navigates
  // because X's own JS makes it. Rewriting its data-href helps only if that JS
  // reads the attribute back at click time, which we cannot verify — so for
  // these, and only these, we keep completing the navigation ourselves. A plain
  // <a href> needs no such treatment: once rewritten, the browser follows it.
  const noNativeNav = new WeakSet();

  function defuseAppStoreLinks() {
    let hit = false;
    let els;
    try { els = document.querySelectorAll(APP_STORE_HREF_SELECTOR); } catch { els = []; }
    for (const el of els) {
      for (const attr of ['href', 'data-href']) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        const next = defuseAppStoreUrl(val);
        if (next !== val) {
          el.setAttribute(attr, next);
          if (attr === 'data-href' && !el.hasAttribute('href')) noNativeNav.add(el);
          hit = true;
        }
      }
    }
    return hit;
  }

  // --- Cancel the bounce at tap time (race safety net only) -------------------
  // Narrow on purpose. The DOM passes are debounced behind requestAnimationFrame
  // and the page's HTML is streamed, so there is a window where a link exists
  // but has not been rewritten yet; a tap landing in it would still go to
  // m.x.com. This closes exactly that window and nothing else.
  //
  // The test is the LIVE attribute: an <a href> we already rewrote resolves to
  // x.com, comes back unchanged from defuseAppStoreUrl(), and is handed straight
  // back to the page — so once the first pass has run this handler stops firing
  // on every ordinary link and on every rewritten anchor. It does NOT keep
  // hijacking rewritten anchors to guard against X navigating from its own copy
  // of the URL: no such code exists — the logged-out bundle has no
  // launch_app_store handling, no m.x.com reference, and its single App Store
  // URL builder is never called. The one exception is noNativeNav (above),
  // where returning early would mean the tap does nothing at all.
  function onClickCapture(e) {
    const el = e.target && e.target.closest && e.target.closest('[href], [data-href]');
    if (!el) return;
    const attr = el.hasAttribute('href') ? 'href' : 'data-href';
    const raw = el.getAttribute(attr);
    if (!raw) return;
    const next = defuseAppStoreUrl(raw);
    if (next === raw && !noNativeNav.has(el)) return;
    if (next !== raw) el.setAttribute(attr, next);
    e.preventDefault();
    e.stopPropagation();
    window.location.assign(next);
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
      `${APP_BANNER_CSS_SELECTOR} { display: none !important; }\n` +
      `body:has(${APP_BANNER_CSS_SELECTOR}) { overflow: auto !important; }\n` +
      // Plain attribute match — no :has() — so the blocking modal is hidden
      // (and stops swallowing touches) even on iOS below 16.4, before the
      // observer gets a chance to remove it.
      `${APP_OBSTRUCTION_SELECTOR} { display: none !important; }\n` +
      `body:has(${APP_OBSTRUCTION_SELECTOR}) { overflow: auto !important; }`;
    root.appendChild(style);
  }

  // --- Debounced runner driven by the observer --------------------------------
  let queued = false;
  function run() {
    queued = false;
    injectStyle();
    killNags();
    defuseAppStoreLinks();
  }
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(run);
  }

  // First pass as early as possible.
  run();

  // Installed once, before anything can be tapped. Independent of the observer
  // so it survives even if the DOM passes miss a lazily-rendered control.
  document.addEventListener('click', onClickCapture, true);

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
