# Reddit Nag Remover — Safari iOS Web Extension (build handoff)

## Goal
A Safari **Web Extension** (not a content blocker) that removes Reddit's
"Get the app to keep using Reddit" blocking sheet and restores scrolling on
mobile Safari. Succeeds where Sink It fails because it runs real JS, releases
the body scroll-lock, and self-heals against rotating IDs / re-injection.

## Repo layout
```
extension/
  manifest.json
  block-reddit-nag.js      <- Reddit content script
  block-x-nag.js           <- X/Twitter content script (independent, see x-nag-remover-plan.md)
  icon-48.png / icon-96.png / icon-128.png
app/
  Main.html / Style.css / Script.js  <- container-app UI, copied over the converter's
                                        placeholder page by apply_app_ui (Fastfile)
.github/workflows/
  ci.yml                   <- lint + invariant tests + auto-release on green main
  release.yml              <- sign with match + upload to TestFlight + GitHub Release
  bump-version.yml         <- manual workflow_dispatch version bump
  security.yml             <- CodeQL on the content scripts
fastlane/
  Fastfile                 <- lanes: certificates, build, beta
  Appfile / Matchfile      <- bundle IDs, team, match git storage
Gemfile                    <- pins fastlane
docs/reddit-nag-remover-plan.md
docs/x-nag-remover-plan.md <- X/Twitter diagnosis and caveats
docs/FASTLANE-MIGRATION.md <- signing/release pipeline + one-time manual setup
icon.png                   <- 512px icon
test/extension.test.js     <- node:test invariant guards (no deps)
```

## manifest.json (MV3)
A content script scoped by `matches` is all that is needed — no `permissions`
/ `host_permissions` block. The user just toggles the extension on for
reddit.com in Safari settings.

## Build & distribution (CI → TestFlight)
This repo does **not** commit an Xcode project. `fastlane`'s `beta` lane
generates one at build time on a macOS runner with Apple's converter, signs it
with `match`, and uploads to TestFlight. Full detail — including the three things
the converter gets wrong and the one-time manual setup — is in
[`FASTLANE-MIGRATION.md`](FASTLANE-MIGRATION.md).

1. `xcrun safari-web-extension-converter extension --ios-only ...` generates the
   container App + Web Extension appex targets into `build/gen`.
2. The Fastfile patches the generated project: forces both bundle IDs
   (`fi.mailhub.keepscrolling` + `.Extension`), repoints the `Info.plist` version
   keys at `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`, and replaces the
   converter's placeholder container-app page with `app/` (feature overview +
   enable steps, version stamped in).
3. `match` syncs the Apple Distribution cert + both App Store profiles; manual
   signing is stamped onto each target.
4. `gym` archives and exports a signed `app-store` IPA; `verify_ipa` asserts the
   shipped artifact's bundle IDs, versions, and that the content script is
   actually inside the appex.
5. `upload_to_testflight` uploads it; a separate ubuntu job publishes the
   changelog + GitHub Release.

> Historical note: releases up to **v0.1.3** were unsigned ad-hoc IPAs
> distributed through `altstore-source.json` and re-signed by SideStore/AltStore.
> That path has been removed.

### Cutting a release
- **Automatic:** merge a Conventional-Commit `feat:` / `fix:` to `main`. `ci.yml`
  computes the next semver, tags it, and calls `release.yml`.
- **Manual:** run the **Bump version and make a release** workflow
  (`workflow_dispatch`) and pick patch/minor/major. Or push a tag: `git tag
  v1.0.0 && git push origin v1.0.0`.

### Installing on iPhone
Accept the TestFlight invite and install Keep Scrolling, then on device:
**Settings ▸ Apps ▸ Safari ▸ Extensions ▸ Keep Scrolling** → enable, set
reddit.com to **Allow** (Allow Always avoids the per-visit prompt). TestFlight
builds expire after 90 days.

### Local build (optional, needs a Mac with Xcode)
```
bundle install
bundle exec fastlane certificates                   # sync signing material
MARKETING_VERSION=1.0.0 bundle exec fastlane build  # full pipeline, no upload
```
To poke at the raw converter output instead:
```
xcrun safari-web-extension-converter ./extension --ios-only
```
Open the generated `.xcodeproj`, set your signing team, build to an iPhone.

## How it works (and why it survives rotation)
- Matches the nag by **stable structural signatures** — `rpl-bottom-sheet[blocking]`,
  `[id*="app-upsell-blocking"]`, and the `faceplate-loader[name^="AppUpsellBlocking"]`
  loader prefix — not the exact IDs (`...-seo` / `...-direct`), which Reddit rotates.
- **Removes the host element**, which pulls any top-layer `<dialog>` (shown via
  `showModal()`) out cleanly, regardless of open/closed shadow root.
- **Releases the scroll lock**: strips `rpl-scroll-lock` / `scroll-is-blocked`
  from `<html>`/`<body>` (their CSS is `overflow:hidden !important`) and re-asserts
  it via an injected stylesheet in case Reddit re-locks without re-rendering a sheet.
- **Self-heals**: a `MutationObserver` (childList+subtree, plus class/open/style
  attribute changes) re-runs on every relevant change, so the lazy 30-second
  injection and any later re-injection get cleaned up automatically.
- Static CSS handles the cosmetic, non-blocking nags (top-nav "Get app" button,
  small header, app-selector) cheaply.
- **The "fog gradient"** is the bottom sheet's `::part(overlay)`
  (`linear-gradient(... var(--color-ui-modalbackground))`), with the card on
  `::part(panel)` and `z-index:999` on `::part(base)`. Removing the host takes
  the whole shadow tree (fog included); the injected stylesheet also neutralizes
  these parts directly as a race-free backstop. This is exactly what Sink It
  misses: it hides only the `-direct` host, the live sheet is `-seo`, so the
  `-seo` overlay (fog) and its scroll lock both pass straight through.

## Caveats / things to verify on-device
- **Cookie/visit gating.** The blocking sheet is partly cookie- and visit-count
  gated (`blocking_seo_lo_30s` = SEO, logged-out, 30s). Logged-in sessions may not
  see it at all. The removal logic is agnostic to the trigger, so it works either
  way — but if you ever want to confirm a regression, clearing reddit.com cookies
  re-arms the trigger for testing.
- **If a future variant slips through**, capture a fresh HTML snapshot and check
  whether the new host still contains `rpl-bottom-sheet[blocking]` or an
  `app-upsell` substring. If Reddit renames both, add the new signature to
  `NAG_SELECTORS`. This is the one line you'd ever need to touch.
- **Don't over-block the loader.** We remove only `faceplate-loader` whose name
  starts with `AppUpsellBlocking`; other faceplate-loaders drive legitimate content.

## References (current as of mid-2026; expect drift)
- piunikaweb.com/2026/05/04/reddit-blocking-mobile-browser-access/ — running log of
  community uBlock filters incl. the `###app-upsell-blocking-bottom-sheet-{seo,direct}`
  hides and the `body,html:style(overflow:auto !important)` scroll fix; also notes
  the cookie-clear reset and that filters "stop working after a few hours."
- Ars Technica (5 May 2026) / MacRumors (11 May 2026) — context on the rollout as a
  logged-out mobile-web A/B block with no native dismiss.
- Snapshot-confirmed names: `app-upsell-blocking-bottom-sheet-seo`, `...-direct`,
  `rpl-bottom-sheet[blocking][open]`, body `rpl-scroll-lock scroll-is-blocked`
  with CSS `.rpl-scroll-lock{overflow:hidden!important}`, and the fog at
  `#app-upsell-blocking-bottom-sheet-seo::part(overlay){background:linear-gradient(...)}`.
