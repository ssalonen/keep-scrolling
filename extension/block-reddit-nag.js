// block-reddit-nag.js
// Safari Web Extension content script.
// Removes Reddit's "Get the app to keep using Reddit" blocking sheet and
// restores scrolling on mobile Safari. Self-heals against re-injection and
// rotating element IDs.
//
// Run at document_start. matches: *://*.reddit.com/*
//
// Design notes:
//  - The nag is <app-upsell-blocking-bottom-sheet-{seo,direct}> wrapping an
//    <rpl-bottom-sheet blocking open>. The teeth are the body classes
//    rpl-scroll-lock / scroll-is-blocked (overflow:hidden !important), which
//    freeze the page even if the sheet itself is hidden.
//  - We match by STABLE structural patterns, not the exact (rotating) IDs, so
//    a rename to e.g. *-blocking-bottom-sheet-foo keeps working.
//  - Removing the light-DOM host pulls any top-layer <dialog> (showModal) out,
//    regardless of whether its shadow root is open or closed.

(() => {
  'use strict';

  // One-shot baseline capture. A bug report is far easier to act on next to the
  // same page with the extension off — that pair is what finally showed X
  // escalating from a banner to a blocking modal when the banner is hidden.
  // Getting it used to mean a trip to Settings and back; the popup can instead
  // set this flag, and the very next page load renders untouched so the reader
  // can capture the "before". It clears itself immediately, so a forgotten flag
  // cannot silently disable the extension.
  try {
    if (sessionStorage.getItem('keep-scrolling:pause-once') !== null) {
      sessionStorage.removeItem('keep-scrolling:pause-once');
      return;
    }
  } catch { /* storage unavailable (private mode, partitioned): just run */ }

  // --- What counts as a blocking nag (host elements we delete outright) ------
  const NAG_SELECTORS = [
    'rpl-bottom-sheet[blocking]',                 // the actual modal mechanism
    '[id*="app-upsell-blocking"]',                // seo + direct + future variants
    '[id*="contextual-app-upsell"]',
    'app-upsell-blocking-bottom-sheet-seo',
    'app-upsell-blocking-bottom-sheet-direct',
    'xpromo-nsfw-blocking-modal',
    '#blocking-modal',
    // Kill the loader BEFORE it boots the bundle (best-effort, prefix is stable):
    'faceplate-loader[name^="AppUpsellBlocking"]',
  ];

  // --- Cosmetic, non-blocking nags: cheap static CSS hide ---------------------
  const COSMETIC_HIDE = [
    '#xpromo-small-header',
    '#xpromo-bottom-sheet',
    'xpromo-app-selector',
    'xpromo-top-button',
    'xpromo-viral-community',
    'inline-auth-landing-experience-xpromo-shell',
    'shreddit-async-loader[bundlename="app_selector"]',
    '[bundlename="app_selector"]',
  ];

  const SCROLL_LOCK_CLASSES = ['rpl-scroll-lock', 'scroll-is-blocked'];

  // --- Release the page scroll (classes + any inline overflow/padding) --------
  function releaseScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      for (const c of SCROLL_LOCK_CLASSES) {
        if (el.classList.contains(c)) el.classList.remove(c);
      }
      if (el.style && el.style.overflow === 'hidden') el.style.overflow = '';
      if (el.style) el.style.removeProperty('padding-right');
    }
  }

  // --- Remove any nag hosts currently in the DOM ------------------------------
  function killNags() {
    let hit = false;
    for (const sel of NAG_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        // Courtesy: close a native dialog so it exits the top layer cleanly.
        try {
          const dlg = el.shadowRoot && el.shadowRoot.querySelector('dialog[open]');
          if (dlg && typeof dlg.close === 'function') dlg.close();
          if (typeof el.close === 'function') el.close();
        } catch { /* ignore */ }
        el.remove();
        hit = true;
      }
    }
    // Always re-assert scroll: Reddit can re-lock the body without re-adding a sheet.
    releaseScroll();
    return hit;
  }

  // --- Inject the static cosmetic-hide stylesheet -----------------------------
  function injectStyle() {
    // No document element to append to yet (possible at document_start): bail
    // out rather than throw. An exception here would propagate out of the first
    // run() call and abort the script before the observer is installed — see
    // the same guard in block-x-nag.js. Later passes retry.
    const root = document.head || document.documentElement;
    if (!root || document.getElementById('rnr-style')) return;
    const style = document.createElement('style');
    style.id = 'rnr-style';
    style.textContent =
      COSMETIC_HIDE.join(',\n') + ' { display: none !important; }\n' +
      // The "fog gradient" is the bottom sheet's ::part(overlay)
      //   (linear-gradient to var(--color-ui-modalbackground)); the card is
      //   ::part(panel), and ::part(base) carries z-index:999.
      // Neutralize the host AND its exposed parts for any *blocking* sheet, so
      // nothing renders and nothing intercepts taps even in the brief window
      // before the observer removes the host.
      'rpl-bottom-sheet[blocking],\n' +
      '[id*="app-upsell-blocking"] { display: none !important; }\n' +
      'rpl-bottom-sheet[blocking]::part(overlay),\n' +
      'rpl-bottom-sheet[blocking]::part(base),\n' +
      'rpl-bottom-sheet[blocking]::part(panel),\n' +
      '[id*="app-upsell-blocking"]::part(overlay),\n' +
      '[id*="app-upsell-blocking"]::part(base),\n' +
      '[id*="app-upsell-blocking"]::part(panel)' +
      ' { display: none !important; background: none !important;' +
      ' pointer-events: none !important; }\n' +
      // If a lock class slips back in before the observer strips it, override it.
      'html.rpl-scroll-lock, body.rpl-scroll-lock,\n' +
      'html.scroll-is-blocked, body.scroll-is-blocked' +
      ' { overflow: auto !important; padding-right: 0 !important; }';
    root.appendChild(style);
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

  // Watch for lazy injection of the sheet and for body class re-locks.
  const observer = new MutationObserver(schedule);
  function startObserver() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'open', 'style'],
    });
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('readystatechange', startObserver, { once: true });

  // Re-assert on load milestones (the 30s timer fires after initial paint).
  for (const ev of ['DOMContentLoaded', 'load']) {
    window.addEventListener(ev, schedule, { once: true });
  }
})();
