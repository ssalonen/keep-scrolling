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

## The Base UI build, and why removal became the bug (issue #25)

A report came in titled *"Page will not scroll on x.com"* whose snapshot showed
a **completely healthy page**: `xnr-style` present, no lock on `<html>` or
`<body>` (no `style` attribute at all on either), `scrollable: true`, no
signature matches, no overlays. Nothing in the lock state explained the
symptom. What did explain it was the *end* of the page: three replies and then
`aria-label="Loading post"` skeletons that never filled in. A post page that
stops after three replies is a page that, to the reader, will not scroll.

Fetching the same status URL with the reporter's iPhone user agent turned three
things up, all of them provable from what X actually serves:

1. **`download` is gone.** Not one occurrence in the whole document, on the
   live page or in the reporter's snapshot. `a[download][href*="launch_app_store=true"]`
   — the banner marker since the first version of this script — had quietly
   stopped matching anything at all, so both the bottom banner and the top-bar
   "Open app" pill were going unhandled. The surviving marker is
   `launch_app_store=true` plus the `ct=` name X gives the surface:
   `ct=post-modal` on the blocking modal's *Open X* button, `ct=post-timeline`
   on the bottom banner, no `ct` on the top-bar pill, and `ct=engagement_*` on
   the engagement controls that must never be touched. `isNagLink()` is that
   one rule.
2. **The blocking modal is now server-rendered.** `data-interaction="app-store-obstruction"`
   is in the raw HTML off the wire, not injected later by the client. So the
   `MutationObserver` removes it *as the parser inserts it*, long before
   `entry-client-logged-out-*.js` hydrates — a structural hydration mismatch on
   a streaming React tree, and the most likely reason the reply list never
   resolves. This is the same failure shape as the earlier "removing an
   `<aside>` ate the reply list" finding, one level up: **removal is the
   hazard**, not the particular element. Hence hiding instead: a
   `data-xnr-hidden` mark plus a rule in our own stylesheet, which React never
   sees, never re-renders away, and which leaves X's own dismiss and unlock
   path working.
3. **X moved from `vaul` to Base UI.** The page preloads
   `useAnchoredPopupScrollLock`, `usePopupHandleStore`, `useRenderElement`,
   `CompositeList`, `useTriggerFocusGuards` — Base UI internals — alongside
   `bottom-prompt`, `modal`, `popover-sheet` and `use-may-obstruct`. Reading
   the shipped chunk, its `useScrollLock` has two paths:

   ```js
   // no scrollbar to compensate for (mobile Safari): both axes, inline
   Object.assign(el.style, { overflowY: 'hidden', overflowX: 'hidden' })

   // otherwise: move the scroll onto <body>
   Object.assign(html.style, { scrollbarGutter, overflowY, overflowX, scrollBehavior: 'unset' })
   Object.assign(body.style, { position: 'relative', height: '100dvh', width: '100vw',
                               boxSizing: 'border-box', overflowY: 'hidden', overflowX: 'hidden' })
   body.scrollTop = savedOffset
   html.setAttribute('data-base-ui-scroll-locked', '')
   ```

   `releaseScroll()` cleared `overflow`/`overflow-y` and `vaul`'s
   `position:fixed`, so the first path was half-covered (`overflow-x` left
   behind) and the second not at all: clear its `overflow-y` and the body is
   still a `100dvh` box, released and unscrollable. `releaseBaseUiLock()`
   keys on Base UI's own `data-base-ui-scroll-locked` — the library's name for
   the thing, in the same spirit as `launch_app_store=true` — clears the whole
   set, and runs **before** the inline-overflow pass because clearing what
   makes `<body>` scrollable resets the `body.scrollTop` the offset is parked
   in.

### How the page freezes: `touch-action`, not `overflow`

Everything above is about locks. The reported symptom was vertical scrolling,
and on this build that has a second, simpler mechanism which no amount of
`overflow` watching would ever see. The blocking modal is
`class="group fixed inset-0 z-50 flex touch-none …"`, and X's stylesheet
defines `.touch-none{touch-action:none}`. A full-viewport element with
`touch-action: none` refuses a finger drag outright: the page is not locked,
it is untouchable.

Driven with real touch events (`Input.dispatchTouchEvent`, which honours
`touch-action`; `window.scrollBy()` does not and proves nothing here) against
the live server-rendered status page with X's own stylesheet loaded:

| | vertical touch drag |
|---|---|
| without the extension | **0 px** — `scrollable: true`, `overflow: visible` on html *and* body, no lock anywhere |
| with the extension | **590 px** |

That first row is the bug report's page state, field for field. It is why every
number in issue #25 read "healthy" while the reader could not move the page,
and why the reporter now also carries a `pan` probe — see `bug-reporting.md`.

Two things this does **not** establish, and neither should be claimed:

- that this particular modal was on screen at the moment the reporter tried to
  scroll. Their snapshot was taken afterwards and contains no
  `app-store-obstruction` at all — v0.8.1 already removed it — and no lock. So
  either it had been dealt with by then, or a same-shaped cover we do not match
  was there. The `pan` probe is what decides that in the next report.
- that removal-before-hydration is what strands the reply list. The skeletons
  are the strongest evidence in the snapshot and that mechanism fits them, but
  the runtime moment was never captured.

## How it works
- Matches the nag via `a[href*="launch_app_store=true"]` filtered by
  `isNagLink()` — the query param and X's own `ct=` surface name are
  purpose-built, semantically-named markers (not rotating hashes), unlike
  the surrounding Tailwind utility classes (`fixed bottom-0 isolate z-40
  ...`), which are cosmetic and could shift on any UI retouch. The
  `download` attribute used to be part of this and no longer exists — see
  "The Base UI build" above.
- `hideNags()` loops over *every* match, not just the first, so it covers all
  known occurrences of the marker without any per-occurrence code: the
  blocking bottom `<aside>` banner, the non-blocking top-bar "Open app" pill,
  and the blocking modal's *Open X* button.
- Hides the whole banner via `.closest('aside')` from the matched anchor,
  falling back to hiding just the anchor if no `<aside>` ancestor is
  found — this is intentional, not just a degrade path: it's exactly what
  happens for the top-bar pill (not `<aside>`-wrapped), and hiding just
  the anchor there is the correct, minimal outcome.
- **Hides rather than removes**, marking the node `data-xnr-hidden` and letting
  the injected stylesheet do the work. The mark is a data attribute rather than
  an inline style so React does not manage it and cannot re-render it away.
- Releases the inline scroll lock on every pass, in all the shapes X has used —
  see "The Base UI build" above and "The `vaul` drawer lock" below.
- Injects a CSS backstop: `[data-xnr-hidden]` and
  `[data-interaction^="app-store-obstruction"]` both `display:none !important`.
  Both are plain attribute selectors, so unlike the `aside:has(...)` rule they
  replaced they need no `:has()` and work below iOS 16.4. The obstruction rule
  in particular hides the server-rendered modal from the first paint, before
  any pass of ours runs. Only the scoped `body:has(...) { overflow:auto }`
  unlock still needs 16.4+, and `releaseScroll()` covers the same ground
  without it.
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
- Runs in the same debounced `run()`, immediately **after** `hideNags()`, so it
  covers both the initial pass and lazily-loaded replies. The order is not
  cosmetic: the param it strips is the marker `hideNags()` matches on, so
  defusing first would blind the hide to a nag rendered since the last pass.
  `ct=engagement_*` is what keeps `hideNags()` off these controls in the first
  place — they are exactly the taps the reader meant to make.
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
  script (diagnosed on-device against the real trigger), this script has been
  built and revised against server-rendered HTML — first a pasted snapshot,
  now a live fetch of a logged-out status page with an iPhone user agent, plus
  X's own shipped `useScrollLock` chunk. Treat `isNagLink()` as a first pass;
  expect at least one iteration after real on-device testing — same loop as
  Reddit's "if a new variant slips through."
- **`.closest('aside')` fallback**: confirmed correct for the known
  top-bar "Open app" pill (anchor-only hiding, no `<aside>` wrapper). Still
  worth an on-device check that no *other* `<aside>`-wrapped variant leaves
  behind an empty fixed-position gradient strip when only the anchor inside
  it gets hidden.
- **On-device finding: removal can eat unrelated content.**
  First on-device test showed replies past the first one stuck as permanent
  "Loading post" skeletons after the banner was removed; the theory then was an
  in-flow `<aside>` reply-list region whose pagination sentinel was deleted
  along with it, and the fix was to only take the whole `<aside>` when
  `getComputedStyle(aside).position === 'fixed'`. Issue #25 brought the
  skeletons back on a page with no `<aside>` at all, which says the ancestor was
  never the whole story — see "The Base UI build" above. The `position: fixed`
  gate stays (it is still the right rule for what to *hide*), but nothing is
  removed from X's DOM any more.
- ~~**Gated `releaseScroll()`**~~ — resolved: on-device the page did stay
  scroll-locked, so the release is now unconditional, matching Reddit. See
  "The `vaul` drawer lock" above.
- **`:has()` support**: only the scoped `body:has(...) { overflow:auto }`
  unlock still needs iOS/Safari 16.4+. Both hide rules are plain attribute
  selectors now, and `releaseScroll()` releases the lock without `:has()`, so
  older iOS is no longer a degraded case.
- **The engagement bounce may have moved into JS.** The page now preloads
  `redirect-to-app-store`, `use-is-app-store-launch` and
  `engagement-intercept-provider`. If tapping Reply still lands in the App
  Store with the param stripped, `defuseAppStoreLinks()` is fighting a
  mechanism that no longer reads the URL, and the next step is to look at what
  `engagement-intercept-provider` binds rather than to widen the selector.

## Manual on-device test (once installed via TestFlight)
Open a logged-out `x.com` (and `twitter.com`) status page in Safari. PASS =
no "See this post in the app" pop-up, the "Open X App" banner and its
background gradient are gone, the page scrolls normally, **the replies past
the first few actually load** (the skeleton check — this is what issue #25
looked like from the reader's seat), and the cookie-consent banner is still
present and functional (negative-control check against over-matching).

## Headless regression run (no device needed)
The logic is DOM-only, so it can be driven in a desktop browser against a
fixture — and the best fixture is free: `curl` the status URL with an iPhone
user agent and you get the server-rendered page including the blocking modal.
Load it with the content script injected at document start and every remote
request blocked, then assert the modal is *hidden but still in the DOM*, the
nag CTAs are marked and the engagement controls are not, the engagement links
have lost `launch_app_store=true` and kept their `ct=`, and the cookie-consent
banner plus any in-flow `<aside>` are untouched. Drive the four lock shapes
(bare `overflow:hidden`, `vaul`'s `position:fixed`, Base UI's two) from small
synthetic fixtures and assert the page scrolls after each.

IMPORTANT: to test *scrolling*, drive a real touch drag —
`Input.dispatchTouchEvent` over CDP (touchStart, a run of touchMoves, touchEnd)
with X's own stylesheet served locally. `window.scrollBy()` and
`Input.synthesizeScrollGesture` do not exercise `touch-action` here, so a run
built on them passes happily against a page no finger can move — which is the
exact failure in issue #25. The control is worth keeping alongside: the same
page *without* the content script must fail to pan, or the fixture is not
reproducing anything.

That part is now committed as **`test/scroll/`** and runs in CI:

```
node test/scroll/run.mjs                            # every known freeze shape
node test/scroll/run.mjs https://x.com/…/status/…   # reproduce a report
```

It fetches a live URL with an iPhone user agent, pulls its stylesheets down
beside it, blocks everything else, and pans it with and without the content
scripts — printing how far each moved and naming the element that refused the
drag. Adding a fixture for a new lock shape is one HTML file. See
`test/scroll/README.md`.

That run is what caught `injectStyle()` throwing on a null
`document.documentElement` at `document_start` — an exception there aborts the
script before the `MutationObserver` is installed, so the page gets no
protection at all for the rest of its life. Both scripts now bail out and retry
instead; keep it that way.
