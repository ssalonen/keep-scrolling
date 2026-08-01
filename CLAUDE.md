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
- `extension/manifest.json` — MV3 manifest declaring both content scripts.
- `extension/icon-{48,96,128}.png` — extension icons.
- `.github/workflows/` — CI/CD (see below).
- `fastlane/` — `Fastfile` (lanes: `certificates`, `build`, `beta`), `Appfile`,
  `Matchfile`. Signing + release live here, not in workflow bash.
- `Gemfile` — pins fastlane.
- `test/extension.test.js` — `node:test` invariant guards (no dependencies).
- `docs/reddit-nag-remover-plan.md` — Reddit diagnosis, build steps, references.
- `docs/x-nag-remover-plan.md` — X/Twitter diagnosis and caveats.
- `docs/FASTLANE-MIGRATION.md` — signing/release pipeline, manual setup steps.

## Build / release / test
- **CI** (`ci.yml`): on every push/PR, syntax-checks both scripts and runs
  `node --test`. On a green push to `main`, computes the next semver from
  Conventional Commits and triggers a release.
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
  run by `generate_project` in the Fastfile, which also forces the bundle IDs and
  repoints the `Info.plist` version keys at the build settings. Patching it is
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
`logged-out-open-app-banner`) and releases the body's inline
`overflow:hidden` scroll lock. This is an independent content script scoped
to `*://*.x.com/*` and `*://*.twitter.com/*` — it deliberately does **not**
share code with the Reddit script (see `docs/x-nag-remover-plan.md` for why).

- Match by the `download` + `launch_app_store=true` marker on the anchor,
  then `.closest('aside')` to remove the whole banner — NOT by the
  surrounding Tailwind utility classes (cosmetic, retouch-prone) and NOT by
  bare `<aside>` or `role="region"` — the page also has an unrelated,
  legally-required cookie-consent banner that must never be touched.
- Unlike Reddit, `releaseScroll()` here only runs when the banner was found
  this pass. X's inline `overflow:hidden` idiom is likely reused by
  unrelated legitimate modals (compose box, image viewer), so releasing it
  unconditionally risks fighting those.
- The injected CSS backstop uses `:has()` (iOS/Safari 16.4+); the JS
  `killNags()` removal path via `MutationObserver` doesn't depend on it and
  still works on older iOS, just without the early-hide race protection.
- **Best-effort first pass**: derived from a single static HTML snapshot, not
  yet verified on-device. If a variant slips through, capture a fresh
  snapshot, confirm the anchor still has `download` + `launch_app_store=true`
  (or find its new marker), and update `APP_BANNER_LINK_SELECTOR` — same
  one-line-of-maintenance goal as Reddit's `NAG_SELECTORS`.

## Conventions
- Vanilla JS only, no dependencies, no build step for the script itself.
- Make minimal changes; do not refactor the script's structure without reason.
- Use Conventional Commits (`feat:`, `fix:`, `chore:`…) — CI derives the release
  version from them.
- If a new variant slips through, capture a fresh HTML snapshot first, confirm the
  new host's signature, then extend `NAG_SELECTORS` / the injected `::part` rules.
