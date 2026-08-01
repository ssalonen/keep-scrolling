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
- **Gated `releaseScroll()`**: if on-device testing shows the page stays
  scroll-locked after the banner is removed (e.g. the banner and the lock
  land in separate mutation batches), loosen this to an unconditional
  release, matching Reddit's behavior.
- **`:has()` support**: the CSS backstop needs iOS/Safari 16.4+. On older
  iOS, the banner still gets removed via `killNags()`/`MutationObserver`,
  just without the earliest possible hide.

## Manual on-device test (once installed via TestFlight)
Open a logged-out `x.com` (and `twitter.com`) status page in Safari. PASS =
the "Open X App" banner and its background gradient are gone, the page
scrolls normally, and the cookie-consent banner is still present and
functional (negative-control check against over-matching).
