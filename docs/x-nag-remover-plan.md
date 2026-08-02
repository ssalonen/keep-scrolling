# X/Twitter Nag Remover — Safari iOS Web Extension

## Goal
Remove X (Twitter)'s logged-out "Open X App" bottom banner and restore
scrolling on mobile Safari, the same way `block-reddit-nag.js` does for
Reddit's blocking sheet. Ships as a second, independent content script in
the same Keep Scrolling extension — one install covers both sites. See
`CLAUDE.md`'s "X/Twitter nag" section for the maintenance-facing summary;
this doc has the fuller diagnosis and caveats.

## Repo layout
See `docs/reddit-nag-remover-plan.md`'s repo layout tree — it covers the
whole repo, including this script and doc.

## What the nag looks like
On a logged-out `x.com` status page, two things happen together:

1. A fixed bottom `<aside>` banner is rendered:
   ```html
   <aside class="fixed bottom-0 isolate z-40 ...">
     <div aria-hidden="true" class="... bg-linear-to-t from-background via-background/45 ..."></div>
     <h2>See all the replies</h2>
     <div>
       <a download href="https://m.x.com/.../status/...?launch_app_store=true&ct=post-timeline">Open X App</a>
     </div>
   </aside>
   ```
   A `<link rel="modulepreload" href=".../logged-out-open-app-banner-*.js">`
   in the page confirms the component is internally named
   `logged-out-open-app-banner`.
2. `<body style="overflow: hidden;">` — an inline scroll lock, structurally
   analogous to Reddit's `rpl-scroll-lock`/`scroll-is-blocked` classes, but
   with no dedicated class of its own.

**Confirmed by an on-device screenshot (logged-out, mobile Safari):** the
exact same `download` + `launch_app_store=true` marker also appears a
*second* time, on a small "Open app" pill in the sticky top bar (next to
"Log in") — a persistent, non-blocking nag, closer to Reddit's cosmetic
top-nav "Get app" button than the blocking sheet. The screenshot also shows
the cookie-consent banner rendered directly underneath the bottom
"Open X App" banner (partially obscured by it) — visual confirmation that
the two are independent, stacked elements, matching the "must never touch"
assumption below.

## How it works
- Matches the banner via `a[download][href*="launch_app_store=true"]` — the
  `download` attribute and the `launch_app_store=true` query param are
  purpose-built, semantically-named markers (not rotating hashes), unlike
  the surrounding Tailwind utility classes (`fixed bottom-0 isolate z-40
  ...`), which are cosmetic and could shift on any UI retouch.
- `killNags()` loops over *every* match, not just the first, so it removes
  both known occurrences of the marker without any per-occurrence code: the
  blocking bottom `<aside>` banner, and the non-blocking top-bar "Open app"
  pill.
- Removes the whole banner via `.closest('aside')` from the matched anchor,
  falling back to removing just the anchor if no `<aside>` ancestor is
  found — this is intentional, not just a degrade path: it's exactly what
  happens for the top-bar pill (not `<aside>`-wrapped), and removing just
  the anchor there is the correct, minimal outcome.
- Releases the inline `overflow:hidden` scroll lock, but **only when the
  banner was actually found this pass** — unlike Reddit's unconditional
  release. X likely reuses plain `overflow:hidden` on `<body>` for other,
  legitimate UI (compose box, image viewer, etc.), and released
  unconditionally this script would fight those.
- Injects a CSS backstop using `:has()`:
  `aside:has(a[download][href*="launch_app_store=true"]) { display:none !important; }`
  and a matching scoped `body:has(...) { overflow:auto !important; }`, so
  the hide/unlock happens race-free even before the `MutationObserver`
  fires. Requires iOS/Safari 16.4+; the JS removal path works regardless.
- Self-heals via the same `MutationObserver` + debounced-run pattern as the
  Reddit script, since X's client-side routing produces DOM mutations the
  observer already watches.

## The "See this post in the app" obstruction dialog
A later snapshot (a `KongBTC` status page, logged out, taken *with the
extension already active* — the injected `<style id="xnr-style">` is visible
in the markup) showed no `<aside>` banner at all. Instead the page was
blocked by a full-screen modal:

```html
<div role="dialog" aria-modal="true" data-state="open"
     data-interaction="app-store-obstruction"
     class="group fixed inset-0 z-50 flex touch-none ...">
  <div aria-hidden="true" data-interaction="app-store-obstruction-backdrop" ...></div>
  <div data-interaction="app-store-obstruction-panel" ...>
    <p>See this post in the app</p>
    <p>Use the app to view all comments and discover more posts.</p>
    ...an animated tap-hand SVG, no link at all...
  </div>
  <button aria-label="Dismiss">…</button>
</div>
```

It is a third, independent mechanism: it contains **no** `launch_app_store`
link and no `<aside>`, so neither `killNags()`'s banner path nor
`defuseAppStoreLinks()` could see it. `fixed inset-0` + `touch-none` means it
swallows the whole viewport whether or not the body is scroll-locked.

- Matched by `[data-interaction^="app-store-obstruction"]` — X's own
  purpose-built, semantically-named marker, the direct analogue of Reddit's
  `[id*="app-upsell-blocking"]`. The `^=` prefix form catches the root and its
  `-backdrop` / `-panel` children in one selector; removing the root takes the
  children with it, so the remaining matches are no-ops.
- Removed regardless of `data-state`. The class list
  (`data-[state=closed]:pointer-events-none`) shows the dialog stays in the
  DOM when dismissed and merely toggles state, so a "remove only when open"
  rule would just wait for it to come back. There is no legitimate state to
  preserve — the element is nothing but the nag.
- Counts as a `hit` in `killNags()`, so the gated `releaseScroll()` also runs
  for it. The snapshot's `<body>` carried no inline lock, but the dialog is
  the kind of UI a scroll-lock library pairs with, and the release is
  scoped to a pass that actually found a nag.
- The CSS backstop rule for it is a plain attribute selector
  (`[data-interaction^="app-store-obstruction"] { display:none !important }`),
  so unlike the banner's `:has()` rules it needs no iOS 16.4+.
- **Must not** be matched by `role="dialog"` / `aria-modal="true"` /
  "fixed inset-0", nor by bare `data-interaction`: the same page tags
  ordinary controls with `data-interaction="mobile-top-bar-log-in"`, and X's
  menus and share sheets are real `role="dialog"` modals.
  `test/extension.test.js` guards both.
- Verified in headless Chromium against a fixture reproducing the snapshot's
  structure: the dialog (root, backdrop, panel) is removed, while the
  cookie-consent banner, a `data-interaction="mobile-top-bar-log-in"` modal,
  and an in-flow `<aside>`'s pagination sentinel all survive. Still worth an
  on-device confirmation on the live site.

## Defusing the app-store bounce on engagement links (`defuseAppStoreLinks()`)
The banner isn't the only app-install nag on a logged-out status page.
On-device testing (a `rcarmo`/`ChimikArt` status page snapshot) showed that
every engagement control — Reply, Repost, Like, Bookmark, and the whole-row
tap target on a reply — carries `href`/`data-href` values like
`https://m.x.com/i/status/<id>?launch_app_store=true&ct=engagement_reply`.
`launch_app_store=true` is X's own explicit signal to bounce the tap to the
App Store, independent of the `<aside>` banner and without a `download`
attribute, so it needed separate handling:

- `defuseAppStoreLinks()` matches `[href*="launch_app_store=true"],
  [data-href*="launch_app_store=true"]` and rewrites the attribute via
  `stripAppStoreParam()`, which removes only the `launch_app_store=true`
  flag (with its `&`/`?`), leaving the rest of the URL — including the
  `ct=engagement_*` analytics param — untouched, so the tap still navigates
  to the real m.x.com endpoint instead of being redirected to the store.
- Runs alongside `killNags()` in the same debounced `run()`, so it covers
  both the initial pass and lazily-loaded replies.
- **Unverified whether this actually suppresses the bounce on-device.** The
  hypothesis is that `launch_app_store=true` is the trigger and m.x.com
  behaves normally without it; if m.x.com bounces regardless of the query
  string, this needs a different approach (e.g. rewriting the host away from
  m.x.com entirely).

## What it must never touch
The page renders legitimate `role="dialog" aria-modal="true"` modals (menus,
share sheets) and tags ordinary controls with `data-interaction` values like
`mobile-top-bar-log-in` — which is why the obstruction dialog is matched by
its `app-store-obstruction` name rather than by its dialog role or its
fixed-full-screen shape.

The same page also renders a legally-required cookie-consent banner:
```html
<div role="region" aria-label="Cookie consent" class="... fixed inset-x-0 bottom-0 ...">
```
This is a `<div>`, not an `<aside>`, and contains no `launch_app_store` link,
so the selector above cannot match it — but this is exactly the kind of
adjacent "also fixed to the bottom of the screen" element that a looser
selector (e.g. bare `<aside>`, or anything keyed on `role="region"` or
`position:fixed; bottom:0`) could accidentally catch. `test/extension.test.js`
has an explicit regression guard for this.

## Caveats / things to verify on-device
- **No live device access was used to build this.** Unlike the Reddit
  script (diagnosed on-device against the real trigger), this script was
  derived from a single pasted static HTML snapshot. Treat
  `APP_BANNER_LINK_SELECTOR` as a first pass; expect at least one iteration
  after real on-device testing — same loop as Reddit's "if a new variant
  slips through."
- **`.closest('aside')` fallback**: confirmed correct for the known
  top-bar "Open app" pill (anchor-only removal, no `<aside>` wrapper). Still
  worth an on-device check that no *other* `<aside>`-wrapped variant leaves
  behind an empty fixed-position gradient strip when only the anchor inside
  it gets removed.
- **On-device finding: whole-`<aside>` removal can eat unrelated content.**
  First on-device test showed replies past the first one stuck as permanent
  "Loading post" skeletons after the banner was removed. Working theory: the
  static-snapshot assumption that the marker link's `<aside>` ancestor is
  *always* the isolated floating banner doesn't hold once real infinite-scroll
  reply-loading is in play — an in-flow `<aside>` could be a reply-list region
  whose pagination sentinel gets deleted along with it. Fixed by only removing
  the whole `<aside>` when `getComputedStyle(aside).position === 'fixed'`
  (matching the documented banner shape: `class="fixed bottom-0 isolate z-40
  ..."`), falling back to anchor-only removal otherwise. Needs to be
  re-verified on-device.
- **Gated `releaseScroll()`**: if on-device testing shows the page stays
  scroll-locked after the banner is removed (e.g. the banner and the lock
  land in separate mutation batches), loosen this to an unconditional
  release, matching Reddit's behavior.
- **`:has()` support**: the CSS backstop needs iOS/Safari 16.4+. On older
  iOS, the banner still gets removed via `killNags()`/`MutationObserver`,
  just without the earliest possible hide.

## Manual on-device test (once installed via TestFlight)
Open a logged-out `x.com` (and `twitter.com`) status page in Safari. PASS =
the "Open X App" banner and its background gradient are gone, no
"See this post in the app" modal appears (including after scrolling on, which
is when it tends to fire), the page scrolls normally, replies keep paginating,
and the cookie-consent banner is still present and functional
(negative-control check against over-matching).
