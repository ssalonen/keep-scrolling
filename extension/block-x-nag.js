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
//    from the banner and need their own handling: strip just the
//    launch_app_store=true param (leaving the rest of the URL, e.g.
//    ct=engagement_reply, intact) so the tap navigates normally instead of
//    being redirected to the store.

(() => {
  'use strict';

  const APP_BANNER_LINK_SELECTOR = 'a[download][href*="launch_app_store=true"]';
  const APP_BANNER_CSS_SELECTOR = `aside:has(${APP_BANNER_LINK_SELECTOR})`;
  const APP_STORE_HREF_SELECTOR =
    '[href*="launch_app_store=true"], [data-href*="launch_app_store=true"]';
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

  function defuseAppStoreLinks() {
    let hit = false;
    let els;
    try { els = document.querySelectorAll(APP_STORE_HREF_SELECTOR); } catch { els = []; }
    for (const el of els) {
      for (const attr of ['href', 'data-href']) {
        const val = el.getAttribute(attr);
        if (val && val.includes('launch_app_store=true')) {
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
