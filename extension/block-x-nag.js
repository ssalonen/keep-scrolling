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

(() => {
  'use strict';

  const APP_BANNER_LINK_SELECTOR = 'a[download][href*="launch_app_store=true"]';
  const APP_BANNER_CSS_SELECTOR = `aside:has(${APP_BANNER_LINK_SELECTOR})`;

  // --- Release the page scroll (inline overflow/padding only) ----------------
  function releaseScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el || !el.style) continue;
      if (el.style.overflow === 'hidden') el.style.overflow = '';
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
    // Only release scroll when we actually found the banner: X reuses plain
    // inline overflow:hidden for unrelated modals, and we don't want to fight
    // those.
    if (hit) releaseScroll();
    return hit;
  }

  // --- Inject a race-free CSS backstop ----------------------------------------
  function injectStyle() {
    if (document.getElementById('xnr-style')) return;
    const style = document.createElement('style');
    style.id = 'xnr-style';
    style.textContent =
      `${APP_BANNER_CSS_SELECTOR} { display: none !important; }\n` +
      `body:has(${APP_BANNER_CSS_SELECTOR}) { overflow: auto !important; }`;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- Debounced runner driven by the observer --------------------------------
  let queued = false;
  function run() {
    queued = false;
    injectStyle();
    killNags();
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
