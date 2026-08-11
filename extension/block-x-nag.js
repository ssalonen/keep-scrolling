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
//  - The scroll lock is an *inline* style on <body> (no dedicated lock class
//    like Reddit's), and it comes in two shapes: the original
//    style="overflow:hidden", and — since X moved its logged-out prompts onto
//    the `vaul` drawer library — style="position:fixed" with the scroll offset
//    stashed in a negative `top`. releaseScroll() undoes both, and runs on
//    every pass rather than only when a nag was matched: a lock we cannot
//    attribute to a nag we recognise is exactly the case that leaves the page
//    frozen with nothing on screen to explain it.
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

  // --- Release the page scroll (inline lock styles only) ---------------------
  // Only ever clears *inline* values, so a stylesheet-driven overflow rule
  // (i.e. the page's own layout) is left alone.
  function releaseScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el || !el.style) continue;
      const s = el.style;

      // 1. The original lock: style="overflow: hidden".
      if (s.overflow === 'hidden') s.overflow = '';
      if (s.overflowY === 'hidden') s.overflowY = '';

      // 2. The `vaul` drawer lock. X now ships that library (its stylesheet,
      //    [data-vaul-drawer]{touch-action:none…}, is injected into logged-out
      //    post pages) and it pins the page with position:fixed !important
      //    plus top/left/right/height, keeping the scroll offset in a negative
      //    `top`. Undo the whole set together and scroll back to where the
      //    user was — dropping `position` on its own teleports them to the top.
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
      //    inline value, never a stylesheet-driven one.
      if (s.pointerEvents === 'none') s.pointerEvents = '';
      s.removeProperty('padding-right');
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

    // Always re-assert scroll, like the Reddit script does. This used to be
    // gated on `hit`, on the theory that X reuses the inline overflow:hidden
    // idiom for legitimate modals we shouldn't fight. On-device that gate is
    // what breaks: X locks the page from prompts that carry none of the
    // markers above (the vaul-drawer variant), so `hit` stays false and the
    // page stays frozen with no nag on screen. A background that scrolls
    // behind an open share sheet is a far cheaper failure than a page that
    // cannot scroll at all.
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
