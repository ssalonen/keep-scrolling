---
name: verify-scrolling
description: Verify that a page can actually be scrolled by a finger, and that the extension is what makes the difference. Use whenever a bug report says the page will not scroll, is frozen, stuck or locked, when changing releaseScroll()/the nag selectors in extension/block-*-nag.js, or when reproducing a scroll freeze on x.com, twitter.com or reddit.com. Also use before claiming any scrolling fix works.
---

# Verifying that a page scrolls

## The one rule

**Drive touch, not `window.scrollBy`.** A page can be perfectly scrollable by
every programmatic measure and still refuse a finger. Issue #25 was exactly
that: a `fixed inset-0` cover with `touch-action: none`, over a document
reporting `scrollable: true`, `overflow: visible` on `<html>` and `<body>`, and
no lock anywhere. Every field in the bug report said the page was healthy.

`window.scrollBy()`, `scrollIntoView()`, wheel events and CDP
`Input.synthesizeScrollGesture` all walk straight past `touch-action`. Only a
real `Input.dispatchTouchEvent` sequence (touchStart, several touchMoves,
touchEnd) with touch emulation enabled exercises it. If you find yourself
writing `window.scrollBy` in a scroll test, stop — you are about to pass a
frozen page.

## Use the harness

```
node test/scroll/run.mjs                            # committed fixtures
node test/scroll/run.mjs https://x.com/…/status/…   # a live page, no JS
node test/scroll/run.mjs https://x.com/…  --with-js # …running its real bundle
node test/scroll/run.mjs snapshot.html              # a page from a bug report
```

Reach for `--with-js` whenever the suspected lock is applied by the site at
runtime rather than server-rendered: it mirrors the page's whole module graph,
serves it from localhost and lets it hydrate offline. (A browser often cannot
use an agent HTTPS_PROXY even when `curl` can — mirroring with Node's `fetch`
sidesteps that entirely.)

**This drives Chromium; iPhones run WebKit.** A green run is evidence, not
proof. Say which engine a result came from, and treat an on-device check as the
last word on any scrolling fix.

Every case runs twice — without the content script and with it — and prints how
far each panned plus the lock state and the element that blocked the drag. Needs
a Chrome/Chromium binary (`CHROME_PATH` if it is somewhere unusual); it exits 77
when there is none. No npm dependencies.

`test/scroll/README.md` has the details.

## The control is half the answer

A green run means nothing on its own. Read **both** numbers:

- **without: 0px / with: 500px+** — reproduced, and the fix is what fixed it.
- **without: 500px+ / with: 500px+** — the fixture is not reproducing anything.
  Do not report this as a fix; the page was never stuck. Find the real trigger
  first (cookie state, A/B variant, a prompt that only appears after a delay).
- **without: 0px / with: 0px** — still broken. The printed `blocked by …` line
  names the element; that is the selector to work from.

And read the **distance available**, printed next to every number:

- **with: 590px of 590px available (1.7 screens)** — the page is fully released
  and *still* feels frozen to the reader, because that is the whole page. This
  is issue #28: nothing to fix in the extension. Say so plainly rather than
  hunting for a lock. `[role="status"]` counts in the bug report name the
  unresolved placeholders the page ends on.

## Reproducing a report

1. Prefer the **live URL** over the snapshot. `sanitizeHtml()` empties `<style>`
   blocks and the page's real stylesheets are remote, so a snapshot often cannot
   reproduce a class-driven `touch-action`. The harness fetches a URL with an
   iPhone user agent and pulls its stylesheets down beside it.
2. If the control pans (no freeze reproduced), the trigger is state you have not
   got — X and Reddit both gate these prompts. Say so rather than declaring it
   fixed.
3. Add a fixture to `test/scroll/fixtures/` for any new lock or cover shape,
   **before** fixing it. One HTML file; the runner picks it up. Watching the
   control fail to pan is the proof you reproduced it.

## When you are changing the nag scripts

`releaseScroll()` may only clear **inline** values, never computed ones — a
stylesheet-driven `overflow` is the site's own layout. And on X, prefer hiding
over removing: X server-renders its blocking modal, and deleting a node React is
about to hydrate against strands the reply list as permanent "Loading post"
skeletons, which a reader experiences as the page not scrolling.

Run `node --test` (invariants, no browser needed) *and* the harness. The
invariant tests pin the shape of the code; only the harness answers whether a
finger can move the page.
