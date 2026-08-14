# Scroll harness — can a finger actually pan the page?

```
node test/scroll/run.mjs                            # the committed fixtures
node test/scroll/run.mjs snapshot.html              # a page from a bug report
node test/scroll/run.mjs https://x.com/…/status/…   # a live page, no JS
node test/scroll/run.mjs https://x.com/…  --with-js # …running its real bundle
```

Run the unit tests as `node --test test/extension.test.js`, **not** a bare
`node --test`: Node treats every file under `test/` as a test file, so a bare
run also imports this harness.

## `--with-js`: the site's own code, offline

Plain URL mode blocks every request, so the site's client never runs — enough
for a server-rendered cover, not enough for a lock applied from a React effect.
`--with-js` mirrors the page and its whole module graph (`mirror.mjs`), serves
it from localhost, and lets it hydrate with nothing else reachable. On X that
reproduces the blocking modal *and* its `touch-action: none`, with X's real
bundle executing:

```
without:    0px  of 590px available, blocked by none on <div … data-interaction="app-store-obstruction" class="… touch-none …">
with:     590px  of 590px available
```

It does **not** reproduce anything needing the site's API — X's conversation
query fails, so the reply list stays as the placeholders the server rendered.
A faithful copy of the *document*, not of a session.

Needs a Chrome/Chromium binary (`CHROME_PATH` overrides the search). No npm
dependencies — it speaks CDP over Node's global `WebSocket`, in the same
no-dependency spirit as the content scripts. Exits `77` when there is no
browser, so it stays optional next to a dependency-free `node --test`.

## Why this exists

Issue #25 was reported as *"the page will not scroll"* and arrived with a
snapshot in which **every field said the page was fine**: `scrollable: true`,
`overflow: visible` on `<html>` and `<body>`, no lock, no overlays. It was all
true. The page was not locked — it was *untouchable*: X's app-install modal is
`fixed inset-0 … touch-none`, and `touch-action: none` over the viewport
refuses a finger drag outright.

Nothing that scrolls a page programmatically can see that:

| how you scroll | sees `touch-action`? |
|---|---|
| `window.scrollBy(0, 500)` | no |
| `element.scrollIntoView()` | no |
| CDP `Input.dispatchMouseEvent` (wheel) | no — wheel is not touch |
| CDP `Input.synthesizeScrollGesture` | did not move the page at all here |
| **CDP `Input.dispatchTouchEvent`** | **yes** |

A regression run built on any of the first four reports "the page scrolls"
against a page no finger can move — which is the bug. So the harness drives a
real `touchStart` / `touchMove`× / `touchEnd` sequence through the renderer's
input pipeline, with touch emulation on.

## The control is half the test

Every case runs **twice**: once without the content script, once with it. Both
halves are assertions.

- With the script, the page must pan. Obviously.
- Without it, a freeze fixture must **fail** to pan. A fixture that pans either
  way is not reproducing anything, and a "fix" measured against it has been
  measured wrong.
- `fixtures/plain.html` is the inverse control: nothing is wrong with it, so it
  must pan both ways. If it ever stops, the harness is broken, not the page.

## Read the distance, not just the movement

Every line prints how far the page panned **and how far it could have**:

```
with:  590px  of 590px available (1.7 screens)
```

That is a page fully released, and it is also what issue #28 was reported as:
*"the page will not scroll"*. The whole document was 1.7 screens — the post,
three replies and two reply placeholders that never filled in — so the reader
flicked, the page moved two thirds of a screen and stopped. Nothing was locked.

`short-page.html` pins that case so the harness says *"nothing is locked, there
is just no page to move"* instead of reporting a lock that does not exist.

Fixtures must declare `<meta name="viewport" content="width=device-width…">`.
Without it Chrome lays the page out at 980px and scales it, and every distance
printed is quietly wrong — a 4000px fixture reported 2227px of scroll instead of
3204px.

## The fixtures

One file per freeze mechanism this extension has actually met:

| fixture | mechanism |
|---|---|
| `plain.html` | nothing wrong — proves the harness can pan a page |
| `touch-action-cover.html` | `fixed inset-0` + `touch-action: none` (issue #25) |
| `inline-touch-action.html` | inline `touch-action: none` on `<body>` |
| `overflow-hidden.html` | inline `overflow: hidden` — the original X lock |
| `vaul-pinned.html` | `vaul`'s `position: fixed` with the offset in a negative `top` |
| `base-ui-mobile.html` | Base UI, no-scrollbar path: inline overflow on both axes |
| `base-ui-desktop.html` | Base UI, scrollbar path: `<body>` becomes a `100dvh` box |
| `short-page.html` | nothing locked — there is just no page to scroll (issue #28) |

Adding one is a single HTML file; `run.mjs` picks up everything in `fixtures/`.
When a new lock shape turns up, add the fixture **first** and watch the control
fail to pan — that is the proof you have reproduced it before you fix it.

## The engine caveat

This drives **Chromium**. iPhones run **WebKit**, and the two do not agree about
everything that matters here — `touch-action` handling, `-webkit-overflow-
scrolling`, rubber-banding at the document edge. A green run is evidence, not
proof, that a fix works on a phone.

Where a closer engine is available, use it: `npx playwright install webkit` and
drive the same fixtures through it, or open the page on the device itself with
Safari Web Inspector from a Mac. Until then, an on-device check stays the last
word on any scrolling fix.

## Reading a report with it

A bug report from the extension links a sanitized snapshot on paste.rs. Note
that `sanitizeHtml()` empties `<style>` blocks and the page's real stylesheets
are remote, so a snapshot alone often cannot reproduce a class-driven
`touch-action`. Passing the **live URL** instead is usually the faster path: the
harness fetches it with an iPhone user agent, pulls its stylesheets down beside
it, blocks everything else, and pans it. That is how issue #25 was reproduced —
0 px without the extension, 590 px with it, and the blocking element named in
the output.
