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

## The blocking "See this post in the app" modal (added after on-device testing)
A second, **blocking** variant showed up on a logged-out status page — the
banner work above did nothing for it, because it is not an `<aside>` and
carries no `launch_app_store` link at all:

```html
<div role="dialog" aria-modal="true" data-state="open"
     data-interaction="app-store-obstruction"
     class="group fixed inset-0 z-50 flex touch-none items-center justify-center">
  <div aria-hidden="true" data-interaction="app-store-obstruction-backdrop"></div>
  <div data-interaction="app-store-obstruction-panel">
    <p>See this post in the app</p>
    <p>Use the app to view all comments and discover more posts.</p>
  </div>
  <button aria-label="Dismiss">…</button>
</div>
```

It covers the viewport (`fixed inset-0`) and sets `touch-action: none`, so it
is *both* halves of the problem at once: the nag itself and the scroll lock.
Removing the dialog root is therefore the whole fix — the backdrop and panel
go with it.

- Matched by `[data-interaction^="app-store-obstruction"]`: X's own semantic
  name for the component, in the same spirit as `launch_app_store=true`.
  Prefix-matched so the `-backdrop`/`-panel` children (and a renamed root)
  stay covered.
- **Never** matched by `role="dialog"`, `aria-modal`, or the `touch-none`
  class. X renders the share menu, the verified-badge popover and other
  legitimate dialogs with exactly that shape; a selector on those would take
  the site apart. `test/extension.test.js` fails if any of those strings
  appears in the script's code.
- Its CSS backstop needs no `:has()`, so unlike the banner's it also protects
  pre-16.4 iOS from the earliest paint.
- `releaseScroll()` additionally clears an inline `pointer-events: none` —
  the modal's lock disables the page behind it that way — but only that exact
  inline value, never a stylesheet-driven one.

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

## Defusing the app-store bounce on engagement links
The banner isn't the only app-install nag on a logged-out status page.
On-device testing (a `rcarmo`/`ChimikArt` status page snapshot) showed that
every engagement control — Reply, Repost, Like, Bookmark, and the whole-row
tap target on a reply — carries `href`/`data-href` values like
`https://m.x.com/i/status/<id>?launch_app_store=true&ct=engagement_reply`.
These have no `download` attribute and no `<aside>` wrapper, so they are a
separate mechanism from the banner and need their own handling.

### The param strip was not enough — the host is the bounce
The first attempt assumed `launch_app_store=true` was the trigger and stripped
just that flag. A later on-device snapshot settled it: the page carried our
`<style id="xnr-style">`, *every* engagement link had already been stripped
down to `https://m.x.com/i/status/<id>?ct=engagement_view_post` — and the tap
still landed on the App Store. **`m.x.com` bounces on its own**, which is the
alternative the previous version of this doc flagged as a caveat.

`defuseAppStoreUrl()` now applies both defusals:

- `stripAppStoreParam()` — removes only the `launch_app_store=true` flag (with
  its `&`/`?`), byte-preserving for the rest of the query string.
- `demobilizeHost()` — rewrites a leading `m.`/`mobile.` host to the apex
  (`m.x.com` → `x.com`, `m.twitter.com` → `twitter.com`). Anchored at the start
  of the URL and followed by a `/`, `?`, `#` or end-of-string boundary, so
  `https://m.x.com.evil.com/…` and `https://evil.com/?u=https://m.x.com/…` are
  both left alone. `m.x.com/<path>` and `x.com/<path>` address the same post,
  so the tap still goes where X pointed it, `ct=engagement_*` and all.

`APP_STORE_HREF_SELECTOR` matches on either marker (the flag *or* the mobile
host), since a link can carry one without the other.

### Two layers, both needed (`defuseAppStoreLinks()` + `onClickCapture`)
Rewriting the attributes on each debounced pass leaves two holes:

1. **The race.** `run()` is debounced behind `requestAnimationFrame`; a tap on
   a just-rendered reply row can land before the rewrite does.
2. **X's own state.** Nothing guarantees X reads the attribute back at click
   time — it may navigate from the URL it holds in JS state, which a content
   script cannot reach. In that case attribute rewriting is inert, and worse,
   it *hides* the problem: the attribute looks defused while the tap still
   bounces. This is consistent with what the on-device snapshot showed.

`onClickCapture` closes both: a capture-phase `click` listener on `document`
that, for a bounce link, calls `preventDefault()` + `stopPropagation()` before
any X listener runs and navigates to the rewritten URL itself.

- It acts **only** on a link `defuseAppStoreUrl()` would change, or one already
  rewritten (tracked in a `defusedEls` `WeakSet`, since those come back
  unchanged from `defuseAppStoreUrl()` on the second look). Every other link is
  returned untouched — cancelling an ordinary X link would break navigation
  site-wide. `test/extension.test.js` guards this.
- The cost is a full page load instead of an SPA transition on those specific
  controls. That is the intended trade: the alternative is the App Store.
- A `WeakSet` rather than a marker attribute, so nothing is added to X's DOM
  that its hydration could trip over.

## What it must never touch
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
no "See this post in the app" pop-up, the "Open X App" banner and its
background gradient are gone, the page scrolls normally, and the
cookie-consent banner is still present and functional (negative-control check
against over-matching).

Then tap the engagement controls, which is what the App Store bounce actually
rides on: **Reply, Repost, Like, Bookmark, and a reply row itself** must all
stay in Safari (they land on the post's `x.com` page) instead of opening the
App Store. Tapping a username, a timestamp or the quoted post must still work
normally — if ordinary navigation breaks, `onClickCapture` is over-matching.

## Headless regression run (no device needed)
The removal logic is DOM-only, so it can be driven in a desktop browser
against a fixture of the on-device snapshot: load the page with the content
script injected at document start, then assert the modal and banner are gone,
the scroll lock and `pointer-events` are released, the engagement links point
at `x.com` with no `launch_app_store=true`, and the cookie-consent banner plus
any in-flow `<aside>` are untouched. Route the browser's document requests back
to the fixture and record them, and the tap behaviour becomes checkable too:
tapping Reply/Like/a reply row must request an `x.com` URL and never `m.x.com`
— including with `requestAnimationFrame` stubbed out (the race) and with a
competing listener that navigates from a stale copy of the URL (X's own state).
That run is what caught `injectStyle()` throwing on
a null `document.documentElement` at `document_start` — an exception there
aborts the script before the `MutationObserver` is installed, so the page
gets no protection at all for the rest of its life. Both scripts now bail out
and retry instead; keep it that way.
