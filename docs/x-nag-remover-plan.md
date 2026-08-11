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

## The `vaul` drawer lock (added after a second on-device report)

A logged-out post page came back scroll-locked with **no nag on screen at
all**. The DOM snapshot from that page is the diagnosis:

- `<style id="xnr-style">` is present and the engagement links read
  `?ct=engagement_reply` with no `launch_app_store=true` — so the content
  script ran fine and `defuseAppStoreLinks()` had already done its pass.
- Neither the `<aside>` banner nor `[data-interaction^="app-store-obstruction"]`
  is anywhere in the document. `killNags()` had nothing to match, so `hit`
  was `false`, so the gated `releaseScroll()` never fired.
- The page now injects **`vaul`**'s stylesheet inline
  (`[data-vaul-drawer]{touch-action:none;…}`, `[data-vaul-overlay]`,
  `[data-vaul-handle]`) and preloads `bottom-prompt-*.js`, `tap-hand-*.js`,
  `use-jetfuel-modal-state-*.js`, `modal-*.js` and `popover-sheet-*.js`
  alongside the familiar `logged-out-open-app-banner-*.js` and
  `use-may-obstruct-*.js`. X has moved its logged-out prompts onto a drawer
  library. `vaul` only injects that stylesheet when a drawer actually mounts.

`vaul` does not lock the body with `overflow:hidden`. It pins it:

```js
document.body.style.setProperty('position', 'fixed', 'important');
Object.assign(document.body.style, { top: `${-scrollY}px`, left: '0px', right: '0px', height: 'auto' });
```

That is invisible to an `overflow`-only release, which is why the page stayed
frozen. Two changes fix it, and both are guarded by `test/extension.test.js`:

1. `releaseScroll()` recognises the pinned-position shape, clears
   `position/top/left/right/width/height` together, and calls
   `window.scrollTo(0, -top)` to put the reader back where they were —
   dropping `position` alone releases the scroll but jumps to the top of the
   thread.
2. The release is no longer gated on `hit`. The gate assumed every lock is
   attributable to a nag we can name; a drawer we have no selector for
   disproves that, and the gate's failure mode (page permanently frozen) is
   much worse than its success case (background scrolls behind a legitimate
   share sheet).

Still only *inline* values are cleared, so X's own stylesheet-driven layout is
untouched.

**Not fixed by this, and not attempted:** the drawer element itself is left in
the DOM, because the snapshot does not contain it and guessing a selector for
a component we have never seen is exactly the over-matching risk this doc
warns about everywhere else. Releasing the lock means the page scrolls with
the prompt still sitting on it. To finish the job, capture a snapshot **while
the prompt is visible** and look for its `data-interaction` name (X labels its
own components that way — `app-store-obstruction`, `mobile-top-bar-log-in`)
or a `[data-vaul-drawer]` root containing an app-store link, then add that
signature to the removal selectors.

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
- Releases the inline scroll lock on every pass, in both the shapes X uses —
  see "The `vaul` drawer lock" below.
- Injects a CSS backstop using `:has()`:
  `aside:has(a[download][href*="launch_app_store=true"]) { display:none !important; }`
  and a matching scoped `body:has(...) { overflow:auto !important; }`, so
  the hide/unlock happens race-free even before the `MutationObserver`
  fires. Requires iOS/Safari 16.4+; the JS removal path works regardless.
- Self-heals via the same `MutationObserver` + debounced-run pattern as the
  Reddit script, since X's client-side routing produces DOM mutations the
  observer already watches.

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
- ~~**Gated `releaseScroll()`**~~ — resolved: on-device the page did stay
  scroll-locked, so the release is now unconditional, matching Reddit. See
  "The `vaul` drawer lock" above.
- **`:has()` support**: the CSS backstop needs iOS/Safari 16.4+. On older
  iOS, the banner still gets removed via `killNags()`/`MutationObserver`,
  just without the earliest possible hide.

## Manual on-device test (once installed via TestFlight)
Open a logged-out `x.com` (and `twitter.com`) status page in Safari. PASS =
no "See this post in the app" pop-up, the "Open X App" banner and its
background gradient are gone, the page scrolls normally, and the
cookie-consent banner is still present and functional (negative-control check
against over-matching).

## Headless regression run (no device needed)
The removal logic is DOM-only, so it can be driven in a desktop browser
against a fixture of the on-device snapshot: load the page with the content
script injected at document start, then assert the modal and banner are gone,
the scroll lock and `pointer-events` are released, the engagement links have
lost `launch_app_store=true`, and the cookie-consent banner plus any in-flow
`<aside>` are untouched. That run is what caught `injectStyle()` throwing on
a null `document.documentElement` at `document_start` — an exception there
aborts the script before the `MutationObserver` is installed, so the page
gets no protection at all for the rest of its life. Both scripts now bail out
and retry instead; keep it that way.
