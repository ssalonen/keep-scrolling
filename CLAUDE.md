# Keep Scrolling — Reddit Nag Remover (Safari iOS Web Extension)

The app is named **Keep Scrolling**, bundle ID `fi.mailhub.keepscrolling` (+
`.Extension` for the appex). It was *Shreddit* / `com.ssalonen.shreddit` up to
v0.1.3. `fi.mailhub.*` matches the other apps on this Apple team, which matters
because match's signing repo is per-team.

- IMPORTANT: do NOT rename the bundle ID now — the App IDs are registered in the
  portal, so a rename means re-registering them AND regenerating every match
  profile, for no user-visible gain.
- In the Fastfile, `APP_NAME` ("KeepScrolling") is the space-free
  Xcode/scheme/IPA name; `APP_DISPLAY_NAME` ("Keep Scrolling") is
  `CFBundleDisplayName`, what users see. Keep them distinct — a space in
  `APP_NAME` leaks into every build path.

Removes Reddit's "Get the app to keep using Reddit" blocking sheet on mobile
Safari and restores scrolling, via `extension/block-reddit-nag.js`. Also
removes X/Twitter's logged-out "Open X App" banner and its scroll lock, via
the independent `extension/block-x-nag.js`. Full background and references:
@docs/reddit-nag-remover-plan.md and @docs/x-nag-remover-plan.md

## Layout
- `extension/block-reddit-nag.js` — the Reddit content script. Runs at
  `document_start` on `*://*.reddit.com/*`.
- `extension/block-x-nag.js` — the X/Twitter content script. Runs at
  `document_start` on `*://*.x.com/*` and `*://*.twitter.com/*`. Independent
  of the Reddit script — see the "X/Twitter nag" section below.
- `extension/collect-report.js` — read-only diagnostics collector for bug
  reports. Runs at `document_idle` on all three hosts; answers a runtime
  message from the popup with a page snapshot. See "Bug reporting" below.
- `extension/report.html` + `extension/report.js` — the toolbar popup that turns
  that snapshot into a prefilled GitHub issue.
- `extension/build-info.json` — version/build placeholders, stamped at build
  time by `apply_build_info` and read by `report.js`.
- `extension/manifest.json` — MV3 manifest declaring the content scripts and the
  popup action.
- `extension/icon-{48,96,128}.png` — extension icons.
- `app/Main.html` — the container app's UI (feature overview + enable steps),
  one self-contained file. Copied over the converter's placeholder page by
  `apply_app_ui` in the Fastfile — see "Container app UI" below.
- `.github/workflows/` — CI/CD (see below).
- `fastlane/` — `Fastfile` (lanes: `certificates`, `build`, `beta`), `Appfile`,
  `Matchfile`. Signing + release live here, not in workflow bash.
- `Gemfile` — pins fastlane.
- `test/extension.test.js` — `node:test` invariant guards (no dependencies).
  Run them with `node --test test/extension.test.js`, not a bare `node --test`:
  Node treats every file under `test/` as a test file, so a bare run also
  imports the browser harness.
- `test/scroll/` — the touch-scroll harness: drives a real finger drag over CDP
  against one fixture per known freeze shape, asserting each is stuck WITHOUT
  the content script and pans WITH it. Also takes a bug report's URL or
  snapshot. No dependencies either — see `test/scroll/README.md`.
- `.claude/skills/verify-scrolling/` — when to reach for that harness, and the
  one rule it exists to enforce.
- `docs/reddit-nag-remover-plan.md` — Reddit diagnosis, build steps, references.
- `docs/x-nag-remover-plan.md` — X/Twitter diagnosis and caveats.
- `docs/bug-reporting.md` — the in-Safari bug reporter: design, redaction, caveats.
- `docs/FASTLANE-MIGRATION.md` — signing/release pipeline, manual setup steps.

## Build / release / test
- **CI** (`ci.yml`): on every push/PR, syntax-checks the extension scripts,
  parses the JSON resources, and runs `node --test test/extension.test.js`. A second job runs the
  touch-scroll harness (`node test/scroll/run.mjs`) — the invariant tests pin
  the shape of the code, only the harness answers whether a finger can move the
  page. It is deliberately *not* a dependency of the release: it needs a
  browser, and a runner without one should not block one. On a green push to
  `main`, computes the next semver from Conventional Commits and triggers a
  release.
- IMPORTANT: "will not scroll" has two causes and the reporter must separate
  them. One is a lock or a `touch-action` cover. The other is that there is
  barely any page: issue #28 was 1.7 screens of content — post, three replies,
  two `role="status"` placeholders that never resolved — fully released by the
  extension, 590px of travel, and it still read as frozen. `lock.maxScroll` /
  `lock.screens` are what tell those apart; `scrollable` is a boolean satisfied
  by 4px and cannot.
- IMPORTANT: to test **scrolling**, drive touch. `window.scrollBy()`,
  `scrollIntoView()`, wheel events and `Input.synthesizeScrollGesture` all
  ignore `touch-action`, so they pass happily against a page no finger can move
  — which is what issue #25 was. `node test/scroll/run.mjs` does it properly;
  reach for it via the `verify-scrolling` skill.
- **Release** (`release.yml`): on a `v*` tag (or `workflow_call`), a macOS `build`
  job runs `bundle exec fastlane beta` — generate the Xcode project from
  `extension/`, sync signing with `match`, archive/export a **signed App Store
  IPA**, verify it, and upload to **TestFlight**. A cheap ubuntu `publish` job
  then writes the changelog + GitHub Release (notes only, no IPA attached).
- **Bump** (`bump-version.yml`): manual `workflow_dispatch` → pick patch/minor/major.
- IMPORTANT: `ci.yml` and `bump-version.yml` call `release.yml` via
  `workflow_call` and **must keep `secrets: inherit`** — secrets do not cross
  `workflow_call`, and without it every signing secret expands to `""`.
- **Install**: via TestFlight. Then on device: Settings ▸ Apps ▸ Safari ▸
  Extensions ▸ enable, set reddit.com to Allow Always.
- **No Xcode project is committed** — it is generated into `build/gen` on every
  run by `generate_project` in the Fastfile, which also forces the bundle IDs,
  repoints the `Info.plist` version keys at the build settings, and declares
  export compliance (`ITSAppUsesNonExemptEncryption`) so TestFlight builds are
  not parked behind a manual question. Patching it is
  safe *because* it is a throwaway artifact; never point the converter at a
  tracked path.
- **Local**: `bundle exec fastlane build` runs the whole pipeline minus the
  upload. See `docs/FASTLANE-MIGRATION.md` for one-time setup.
- **Manual on-device test**: open a subreddit post logged-out in Safari, wait past
  the ~30s timer. PASS = no fog overlay, page scrolls, no "Get the app" sheet. To
  re-arm the trigger between tests, clear reddit.com cookies (it is visit/cookie-gated).
- iOS has no DOM inspector locally; use Safari Web Inspector from a Mac for
  diagnosis. Disable Safari's "Hide distracting items" while testing so you are
  measuring the extension, not the manual rule.

## How the nag works (1-paragraph model)
The nag is `<rpl-bottom-sheet blocking open>` inside
`app-upsell-blocking-bottom-sheet-{seo,direct}`, lazy-loaded via a
`faceplate-loader[name^="AppUpsellBlocking"]`. The "fog gradient" is the sheet's
`::part(overlay)`; the card is `::part(panel)`. The thing that actually freezes
the page is the `.rpl-scroll-lock` / `.scroll-is-blocked` class on `<body>`
(`overflow:hidden !important`). Sink It fails because it hides only the `-direct`
host; the live variant is `-seo`, so its fog and scroll-lock pass through.

## Invariants — do not regress
- IMPORTANT: any fix MUST do BOTH of these, never just one: (1) remove/neutralize
  the blocking sheet + its `::part(overlay)` fog, and (2) release the body scroll
  lock. Hiding the sheet without releasing scroll leaves the page frozen.
- Match by STABLE signatures (`rpl-bottom-sheet[blocking]`,
  `[id*="app-upsell-blocking"]`, loader name prefix `AppUpsellBlocking`), NOT the
  rotating `-seo` / `-direct` suffixes. Adding a new signature to `NAG_SELECTORS`
  is the only line that should ever need maintenance.
- Do NOT broaden the `faceplate-loader` removal beyond the `AppUpsellBlocking`
  name prefix — other faceplate-loaders drive legitimate content.
- Keep the `MutationObserver` reactive design: the sheet is injected late and can
  re-inject; one-shot removal is not enough.
- `test/extension.test.js` enforces these invariants in CI — keep it green.

## X/Twitter nag (`extension/block-x-nag.js`)
Removes X's logged-out "Open X App" bottom banner (an `<aside>` containing
`a[download][href*="launch_app_store=true"]`, component internally named
`logged-out-open-app-banner`), the top-bar "Open app" pill, and the blocking
"See this post in the app" modal
(`[data-interaction^="app-store-obstruction"]`), and releases the page's
inline scroll lock. This is an independent content script
scoped to `*://*.x.com/*` and `*://*.twitter.com/*` — it deliberately does
**not** share code with the Reddit script (see `docs/x-nag-remover-plan.md`
for why).

- IMPORTANT: the **blocking** variant is a full-screen
  `div[role="dialog"][aria-modal]` with `fixed inset-0 … touch-none` that
  swallows every touch — the banner logic never saw it, which is why the nag
  survived through v0.5.x. `.touch-none{touch-action:none}` is how it actually
  freezes the page, and that is **not a scroll lock**: `overflow` stays
  `visible` on `<html>` and `<body>`, the document stays taller than the
  viewport, and every field a bug report collects reads healthy while no finger
  can move the page (issue #25). Measured with real touch events against the
  live page: 0 px of vertical drag without the extension, 590 px with it. When
  testing scroll, drive touch — `window.scrollBy()` ignores `touch-action` and
  will pass against a frozen page. Match it only by `data-interaction` (X's own
  semantic name for it, prefix-matched so `-backdrop`/`-panel`/a renamed root
  are covered), NEVER by `role="dialog"`, `aria-modal` or `touch-none` — X
  uses that same shape for the share menu and other legitimate dialogs.
  `test/extension.test.js` guards this.

- IMPORTANT: the script **hides** nags (`data-xnr-hidden` + a rule in its own
  stylesheet); it does not remove them. X now **server-renders** the blocking
  modal, so deleting it at `document_start` deletes a node React is about to
  hydrate against — the reply list comes back as permanent "Loading post"
  skeletons and the post page ends after three replies, which a reader
  experiences as *the page will not scroll* (issue #25). Hiding is invisible to
  React, leaves X's own dismiss/unlock path intact, and cannot take
  surrounding content with it. A data attribute + stylesheet rather than an
  inline style, so a re-render does not undo it.
- IMPORTANT: do **not** require the `download` attribute. It was the banner's
  marker up to v0.8.x and X has since dropped it from every app-store link —
  `a[download][href*="launch_app_store=true"]` matched *nothing* on the shipped
  page, so the banner and the top-bar pill went unhandled. The surviving marker
  is `launch_app_store=true` plus X's own `ct=` surface name; `isNagLink()`
  treats a link as a nag unless its `ct` starts with `engagement` (see the
  engagement-controls note below). Known values: `ct=post-modal` (the blocking
  modal's CTA), `ct=post-timeline` (the bottom banner), no `ct` at all (the
  top-bar "Open app" pill).
- Match by that marker, then `.closest('aside')` to hide the whole banner —
  NOT by the surrounding Tailwind utility classes (cosmetic, retouch-prone)
  and NOT by bare `<aside>` or `role="region"` — the page also has an
  unrelated, legally-required cookie-consent banner that must never be touched.
- IMPORTANT: only hide the whole `<aside>` when `getComputedStyle(aside).
  position === 'fixed'` (the banner's actual shape). An on-device test found
  that blindly removing any `<aside>` ancestor took out an in-flow reply-list
  region along with it, permanently stalling reply pagination — anchor-only
  hiding is the safe fallback when the ancestor isn't the floating banner.
- IMPORTANT: `hideNags()` must run **before** `defuseAppStoreLinks()` in
  `run()`. The param the latter strips is the marker the former matches on.
  The hide itself survives (it is recorded on the node, not re-derived each
  pass), but the order is what lets a freshly rendered nag be recognised.
- IMPORTANT: `releaseScroll()` runs on **every** pass, like Reddit's — it is
  no longer gated on "a nag was found this pass". That gate was the v0.6.x
  freeze: X locks the page from prompts carrying none of our markers, so the
  gate never opened and the page stayed frozen with nothing on screen to
  explain it. A background that scrolls behind an open share sheet is a far
  cheaper failure than a page that cannot scroll at all.
- IMPORTANT: the lock has had **four shapes** across four X builds and all of
  them must be undone. (1) inline `overflow:hidden` on `<body>`. (2) `vaul`,
  the drawer library X shipped for a while: `position:fixed !important` plus
  `top/left/right/height`, with the scroll offset stashed in a negative `top`
  — clear that whole set together **and** `window.scrollTo` back to `-top`, as
  dropping `position` alone releases the scroll but teleports the reader to the
  top of the thread. (3) and (4) come from **Base UI**, the popup library X has
  since moved its logged-out prompts onto (`useAnchoredPopupScrollLock`,
  `usePopupHandleStore`, `useRenderElement` in the page's preloads): on mobile
  Safari, where there is no scrollbar to compensate for, it just sets inline
  `overflow-x`/`overflow-y: hidden`; otherwise it marks `<html>` with its own
  `data-base-ui-scroll-locked` and moves the scroll onto `<body>` as a
  `position:relative`, `100dvh`×`100vw`, `border-box` box with the reader's
  offset parked in `body.scrollTop`. Clearing `overflow` alone leaves that body
  clamped to a single viewport — released, and still unscrollable — so
  `releaseBaseUiLock()` clears the whole set, and runs **first**, because it
  has to read `body.scrollTop` back before the styles that make body scrollable
  come off.
- `releaseScroll()` only ever clears *inline* values (never computed ones), so
  a stylesheet-driven overflow rule — X's own layout — is left alone. It also
  clears an inline `pointer-events:none`, which is how the blocking modal
  disables the page behind it, but only that exact inline value.
- IMPORTANT: `injectStyle()` must never throw. At `document_start` there can
  be no `document.documentElement` to append to, and an exception in the
  first `run()` aborts the script *before* the `MutationObserver` is
  installed — silently disabling the extension for the whole page load. Both
  scripts bail out and retry on a later pass instead.
- The injected CSS is what actually hides things now, and the two rules that
  matter — `[data-xnr-hidden]` and `[data-interaction^="app-store-obstruction"]`
  — are plain attribute selectors, so they work below iOS 16.4 too. Only the
  `body:has(…) { overflow:auto }` unlock still needs `:has()` (16.4+), and
  `releaseScroll()` covers the same ground without it.
- **Maintenance loop**: if a variant slips through, capture a fresh snapshot,
  find the anchor's current marker, and update `isNagLink()` /
  `APP_STORE_LINK_SELECTOR` — same one-line-of-maintenance goal as Reddit's
  `NAG_SELECTORS`. The current rules are verified against a live
  server-rendered `x.com` status page, not on-device.
- IMPORTANT: the app-install nag isn't only the `<aside>` banner. Every
  logged-out engagement control (Reply/Repost/Like/Bookmark, and a reply
  row's whole-row tap target) carries `launch_app_store=true` in its
  `href`/`data-href` — X's own signal to bounce that tap to the App Store.
  These are controls the reader meant to tap, so `hideNags()` must never hide
  them; `ct=engagement_*` is exactly what keeps `isNagLink()` off them.
  `defuseAppStoreLinks()` strips just that param (via `stripAppStoreParam()`)
  from any matching `href`/`data-href`, leaving the rest of the URL (e.g.
  `ct=engagement_reply`) intact, and runs on every pass after `hideNags()`.
  **Unverified on-device** whether removing the param actually suppresses the
  bounce — and X now also preloads `redirect-to-app-store` and
  `engagement-intercept-provider`, which suggests the bounce has a JS path the
  param strip cannot reach. See `docs/x-nag-remover-plan.md`.

## Bug reporting (`extension/report.*`, `extension/collect-report.js`)
A toolbar popup (Safari's **ᴀA** menu ▸ Keep Scrolling) lets a user tick which
of the known failures they saw, describe it, and file it as a **prefilled GitHub
issue** carrying the page URL, the shipped version, the scroll-lock state, which
nag signatures are still in the DOM, what is pinned over the viewport, which
components the page preloaded, and a sanitized copy of the page HTML. It exists
because the maintenance loop for both scripts starts with "capture a fresh HTML
snapshot", and iOS gives a user no way to do that. Full design:
@docs/bug-reporting.md

- IMPORTANT: the extension uploads **exactly one thing to exactly one place**:
  the sanitized page snapshot, POSTed to `https://paste.rs/` (`SNAPSHOT_ENDPOINT`),
  so the issue can link it. This reversed the older "never uploads anything"
  rule on purpose — a GitHub issue body caps at 65 536 chars and cannot hold a
  snapshot. It happens only from the file button, only with the upload box
  ticked, and the preview discloses it first. The issue itself is still never
  submitted for the user: `tabs.create()` on
  `github.com/…/issues/new?title=…&body=…` and they press Submit.
  `test/extension.test.js` pins the shape — two `fetch`es (packaged
  `build-info.json` + the upload), one `POST`, two remote URLs, endpoint ==
  `host_permissions`, and no `XMLHttpRequest`/`sendBeacon`/`Authorization`/
  `credentials:`. Three places state the trade — the checkbox, the preview, and
  `app/Main.html`'s privacy card — and a test fails if the app page goes back
  to claiming nothing ever leaves.
- IMPORTANT: Safari does **not** grant `host_permissions` at install, and its
  popup is dismissed the moment anything takes focus. So a `fetch` that raises
  the per-site prompt destroys the popup mid-upload — the v0.8.0 on-device
  failure: a prompt flashed past on the way to GitHub and the issue arrived
  with no snapshot link. The grant is therefore asked for on a **standalone
  "Allow paste.rs" button** (losing the popup there costs nothing) and the file
  button skips the upload when it is refused. Every no-link branch is recorded
  in the issue as `uploadOutcome` — declined / not allowed / failed — because
  otherwise the three are indistinguishable in a filed report.
- IMPORTANT: paste.rs facts the code depends on, all measured rather than
  documented: **393 216 bytes** is the ceiling and past it the host answers
  `206` and keeps the paste **cut from the front** (so `trimToBytes()`
  middle-cuts by BYTES before posting); **`/<id>.html` renders** the paste, so
  the link is stored extension-less; it sends **no CORS headers** and 404s
  `OPTIONS`, so the request must stay CORS-simple and needs `host_permissions`;
  and it is **heavily rate limited**, so every path degrades to the clipboard.
- IMPORTANT: `collect-report.js` is **read-only**. It is a third content script
  precisely so a diagnostics bug cannot take the nag removal down with it; the
  tests fail if `.remove()`, `setAttribute`, `classList`, `appendChild` or
  `innerHTML =` ever appears in it. Do not merge it into either nag script.
- The snapshot is taken *after* the nag scripts ran, so zero signature matches
  is the normal case. `scriptsActive` (are `#rnr-style` / `#xnr-style` present?)
  is what separates "clean page" from "the extension never ran" — if either
  script ever renames its injected `<style>` id, update `SCRIPT_MARKERS`.
- The popup leads with a **multi-select of the three known failures** (nag still
  visible / page will not scroll / overlay covers the page, plus "something
  else"), because those are different bugs in different code and a tapped box
  beats an empty text field. `SYMPTOMS` in `report.js` is the single source: the
  checkboxes are rendered from it, and the tests fail if a label is copied into
  `report.html`. The first ticked box also seeds the issue title.
- IMPORTANT: the page HTML does NOT fit the prefilled URL and never will —
  `URL_BUDGET = 6000` holds ~2 000 chars of report. The **clipboard is the
  transport** for it. `fitIssue()` therefore drops whole sections (HTML →
  signature samples → overlays/components → lock state → clip the text), never
  a fragment of one: half a snapshot is the top of `<head>`, which spends the
  budget and diagnoses nothing. When the HTML is dropped, the body says so in
  its place and points at the clipboard — without that line the issue reads as
  complete and nobody pastes. Keep the order, and keep the note.
- IMPORTANT: the clipboard is bounded too. GitHub rejects an issue body over
  **65 536 characters** ("Body can not be longer than 65536 characters"), a
  server-side check on the pasted text — shipping an untrimmed copy made the
  paste fail outright. `fitClipboard()` budgets it at `BODY_BUDGET = 65000`,
  and the preview shows exactly what will paste. Both paths share `shrink()`
  and differ only in what they measure.
- IMPORTANT: when the page HTML must be cut, cut the **middle** and keep both
  ends (`trimMiddle()` in `report.js`, `clampDocument()` in
  `collect-report.js`). `<head>` carries the preloads/stylesheets that named
  both variants in `docs/`; the nags are appended late in `<body>`. A
  head-first truncation keeps the one part of the document that never contains
  the bug being reported — which is what the collector's cap originally did.
- The overlay/component block is deliberately trimmed (`ISSUE_OVERLAYS`,
  `ISSUE_TAG_LIMIT`) so it *survives* that trim on a real page — a diagnostics
  block dropped from every issue is the same as not collecting it. A test sizes
  a realistic X-status-page report end to end and fails if it stops fitting.
- IMPORTANT: `sanitizeHtml()` redacts the `content` of **every** `<meta>`, not
  just credential-named ones. The head is where a page parks its CSP nonce,
  Sentry trace/baggage ids, request ids and build hashes, under names no pattern
  predicts — and meta content diagnoses no nag, so the allowlist
  (`viewport`, `charset`, …) is tiny on purpose. `nonce` is in the
  credential-attribute pattern for the same reason.
- `sanitizeHtml()` is best-effort redaction, not a security boundary: a
  logged-in page's HTML contains that session's content. The popup compensates
  by showing the exact text before anything is sent and making the HTML block a
  checkbox — keep both.
- Unlike `app/Main.html`, the popup **must not** inline its JS: extension pages
  run under MV3's `script-src 'self'`, which blocks inline scripts. The two
  pages have opposite constraints for opposite reasons.
- `build-info.json` is stamped in the *generated* project by `apply_build_info`
  (like `apply_app_ui`), never in the tracked file, and `verify_ipa` asserts the
  shipped values. `manifest.json`'s own `version` stays a placeholder — the
  converter reads it on the way to `Info.plist`.
- IMPORTANT: the generated project keeps **no copy** of `extension/` — it
  *references* the tracked directory. Searching `build/gen` for an extension
  file therefore always finds nothing, which failed two releases in a row
  (v0.6.0 on `build-info.json`, v0.6.1 on `manifest.json` itself, a file every
  shipped IPA demonstrably contains). Note `Dir.glob "**"` does not descend
  into a symlinked directory either, so a symlinked `Resources` looks identical
  to an absent one. `sync_extension_resources` resolves the appex's resource
  directory **from the target's Copy Bundle Resources phase**, copies the
  referenced tree to `build/gen/ExtensionResources`, and repoints the
  references — which is what makes `apply_build_info` safe to stamp without
  rewriting the tracked file. Adding a file to `extension/` needs no Fastfile
  change; anything unregistered is copied in and registered.

## Container app UI (`app/`)
The container app (the home-screen icon) does nothing functional — the product
is the extension — but it is the only screen a user ever sees, and the converter
ships it as one line of placeholder text. `app/` replaces that with a short
feature overview and the enable steps, in the same no-dependency spirit as the
content scripts: system fonts, inline SVG glyphs, light + dark, safe-area
insets, **zero network requests**.

- `apply_app_ui` (Fastfile) copies `app/Main.html` over the generated app's own
  `Main.html` and substitutes `__APP_VERSION__` with the build's version.
  `verify_ipa` then asserts the shipped `.app` really contains our page at the
  right version — a converter template move would otherwise silently re-ship
  Apple's placeholder.
- IMPORTANT: the page must scroll on its own. Apple's app template disables
  the web view's scroll view on iOS (`webView.scrollView.isScrollEnabled =
  false`) because its placeholder page is one line, which left everything
  below the fold unreachable in our overview screen. Two layers fix it and
  both are guarded by `test/extension.test.js`: `enable_app_scrolling`
  (Fastfile) flips that line in the generated Swift, and `main` is an
  `overflow-y:auto` container so the page scrolls inside WebKit even if a
  future template moves the line.
- IMPORTANT: overwrite the template's `Main.html` **in place**; do not add
  files. The generated project references exactly that path, so anything new
  would be copied but never bundled unless registered with `xcodeproj`.
- IMPORTANT: keep the page **one self-contained file** — CSS, JS and the icon
  all inline. Two release failures came from assuming otherwise: the template
  ships no `Script.js` at all (v0.5.1), and it localizes the page into
  `<App>/Resources/Base.lproj/` while plain resources land at the `.app` root,
  so relative references to siblings do not resolve at runtime (v0.5.0 was the
  same directory assumption). `apply_app_ui` globs per filename for the same
  reason — never hard-code the layout.
- IMPORTANT: `__APP_VERSION__` must appear **exactly once** in the page.
  `apply_app_ui` gsubs every occurrence, so a second one (e.g. inside the
  inline script) is rewritten too — that is why the script detects an
  unsubstituted footer by shape (`/^Version\s/`) rather than by the token.
- Keep the two host contracts from Apple's template: a global
  `show(platform, enabled, useSettingsInsteadOfPreferences)` (the ViewController
  calls it via `evaluateJavaScript`) and the `"open-preferences"` message to
  `webkit.messageHandlers.controller` (macOS-only button).
- Keep the overview truthful: `test/extension.test.js` asserts every host in
  `manifest.json` is named on the page, so adding a third site to the manifest
  fails CI until the copy mentions it.

## Conventions
- Vanilla JS only, no dependencies, no build step for the script itself.
- Make minimal changes; do not refactor the script's structure without reason.
- Use Conventional Commits (`feat:`, `fix:`, `chore:`…) — CI derives the release
  version from them.
- If a new variant slips through, capture a fresh HTML snapshot first, confirm the
  new host's signature, then extend `NAG_SELECTORS` / the injected `::part` rules.
