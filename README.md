# Keep Scrolling

A Safari **Web Extension** for iOS/macOS that removes Reddit's *"Get the app to
keep using Reddit"* blocking sheet on mobile Safari and restores scrolling.

> Formerly *Shreddit* (`com.ssalonen.shreddit`) up to v0.1.3; now
> `fi.mailhub.keepscrolling`.

Unlike content-blocker rules (e.g. Sink It), it runs real JavaScript at
`document_start`, **releases the body scroll-lock**, neutralizes the blocking
bottom-sheet *and* its fog overlay, and **self-heals** against re-injection and
Reddit's rotating element IDs.

## Install on iPhone (TestFlight)

Releases are signed and uploaded to **TestFlight**. Accept the tester invite,
install **Keep Scrolling** from the TestFlight app, then:

> **Settings ▸ Apps ▸ Safari ▸ Extensions ▸ Keep Scrolling** → enable, and set
> reddit.com, x.com and twitter.com to **Allow** (Allow Always avoids the
> per-visit prompt).

The app's own screen repeats these steps alongside a short overview of what it
does — there is nothing to configure in it.

> **Note:** Shreddit previously shipped as an unsigned IPA installed through
> SideStore/AltStore. That path is gone — the `altstore-source.json` source URL
> no longer resolves, and existing SideStore installs will not update. TestFlight
> builds expire after 90 days, so a fresh release is cut at least quarterly.

## How it works

The nag is `<rpl-bottom-sheet blocking open>` inside
`app-upsell-blocking-bottom-sheet-{seo,direct}`, lazy-loaded via a
`faceplate-loader[name^="AppUpsellBlocking"]`. The thing that actually freezes
the page is the `.rpl-scroll-lock` / `.scroll-is-blocked` class on `<body>`.
The single content script `extension/block-reddit-nag.js`:

- matches the nag by **stable structural signatures**, not the rotating
  `-seo` / `-direct` IDs;
- **removes the host** (pulling any top-layer `<dialog>` out cleanly) and
  neutralizes its `::part(overlay)` fog;
- **releases the scroll-lock** classes and re-asserts `overflow:auto` via CSS;
- **self-heals** with a `MutationObserver` for the lazy ~30s injection and any
  later re-injection.

See [`docs/reddit-nag-remover-plan.md`](docs/reddit-nag-remover-plan.md) for the
full diagnosis and references.

## Development & releases

- `extension/` — the MV3 web extension (the whole product).
- `app/Main.html` — the container app's screen: a short overview of what the
  extension does plus the enable steps, as one self-contained page. Copied over
  the converter's placeholder page at build time by `apply_app_ui`.
- `test/extension.test.js` — `node:test` invariant guards; run with `node --test`.
- `fastlane/` — signing (`match`) and release lanes; see
  [`docs/FASTLANE-MIGRATION.md`](docs/FASTLANE-MIGRATION.md).
- No Xcode project is committed; it is generated at build time with
  `xcrun safari-web-extension-converter`, then signed by `match`.

Releases are automated:

- merge a Conventional-Commit `feat:`/`fix:` to `main` → CI tags + builds, **or**
- run the **Bump version and make a release** workflow and pick patch/minor/major, **or**
- push a tag: `git tag v1.0.0 && git push origin v1.0.0`.

### Local signing (needs a Mac with Xcode)

```sh
bundle install
bundle exec fastlane certificates                  # sync signing material
MARKETING_VERSION=1.0.0 bundle exec fastlane build  # full pipeline, no upload
```

`bundle exec fastlane beta` is what CI runs — it adds the TestFlight upload.
First-time setup (App IDs, the App Store Connect record, the `match` signing repo
and its secrets) is documented in
[`docs/FASTLANE-MIGRATION.md`](docs/FASTLANE-MIGRATION.md).
