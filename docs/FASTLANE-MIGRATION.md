# fastlane signing & release pipeline

Adapted from [`ssalonen/every-byte-counts`](https://github.com/ssalonen/every-byte-counts)
(`docs/FASTLANE-MIGRATION.md` there). This document records what changed here
and, crucially, **the one-time setup that still has to happen by hand**.

> Naming: the app is now **Keep Scrolling** (`fi.mailhub.keepscrolling`). It was
> called **Shreddit** (`com.ssalonen.shreddit`) for releases up to v0.1.3, and
> references to that name below are historical and deliberate. The bundle ID was
> re-based onto `fi.mailhub.*` to match the other apps under this Apple team —
> which matters because match's signing repo is per-team, not per-app. This was
> free to do only because the old ids were never registered in the portal; once
> they are, renaming costs App ID re-registration plus profile regeneration.
>
> In the Fastfile, `APP_NAME` (`KeepScrolling`) is the space-free name driving
> the generated project, scheme, and `.ipa` filename, while `APP_DISPLAY_NAME`
> (`Keep Scrolling`) is stamped as `CFBundleDisplayName` and is what users see.
> Keeping them separate stops spaces leaking into build paths.

## What changed

Shreddit used to build an **unsigned (ad-hoc) IPA** that SideStore/AltStore
re-signed with the installing user's own Apple ID, distributed through
`altstore-source.json`. It now builds a **properly signed App Store IPA** with
`match` and uploads it to **TestFlight**, exactly like every-byte-counts.

| Before | After |
|--------|-------|
| `CODE_SIGNING_ALLOWED=NO`, no team | `match` (Apple Distribution cert + App Store profiles) |
| `Payload/` zipped by hand into `Shreddit.ipa` | `gym` archive + export, `export_method: app-store` |
| IPA attached to the GitHub Release | Uploaded to TestFlight; Release is notes-only |
| `altstore-source.json` updated + committed to `main` by CI | **Deleted** — no SideStore path |
| ~120 lines of inline bash in `release.yml` | `fastlane/Fastfile` lanes, runnable on a Mac |
| One `macos-latest` job did everything | `build` (macOS) + `publish` (ubuntu) |

### Why this is a bigger change here than in every-byte-counts

every-byte-counts already shipped to TestFlight; fastlane only replaced *how it
signed*. Shreddit had **no signing at all**, so this migration also changes the
**distribution model**:

- **Existing SideStore users stop receiving updates.** The source URL
  `https://raw.githubusercontent.com/ssalonen/shreddit/main/altstore-source.json`
  now 404s, which SideStore surfaces as a source error. There is no automatic
  migration path — those users must be moved to TestFlight manually.
- **TestFlight builds expire after 90 days**, so a release is needed at least
  quarterly to keep testers on a working build. (The upside: no more 7-day
  SideStore re-sign treadmill.)
- **External testers need Beta App Review.** Internal testers (up to 100, on
  your own team) get builds immediately — `upload_to_testflight` is configured
  with `skip_submission: true`, so nothing is ever auto-submitted for review.

## Layout

```
Gemfile                     # pins fastlane; commit the generated Gemfile.lock
fastlane/
  Appfile                   # bundle ID + APPLE_TEAM_ID
  Fastfile                  # lanes: certificates, build, beta
  Matchfile                 # git storage, type: appstore, BOTH bundle IDs
```

### Lanes

- **`certificates`** — `match(readonly: is_ci)`. Seeds/syncs signing from a Mac.
- **`build`** — generate, sign, archive, export, verify. No upload. This is the
  local sanity check that CI is reproducible.
- **`beta`** — `build` + `upload_to_testflight`. What `release.yml` runs.

Two details carried over from the reference:

- **`setup_ci` must run first on CI** — it creates the temporary keychain `match`
  installs the cert into. Without it `match` fails on the runner.
- **`match(api_key:)` and `upload_to_testflight(api_key:)`** — feeding the App
  Store Connect API key into both means **no `APPLE_ID` / password / 2FA
  anywhere**.

## The Shreddit-specific problem: there is no committed Xcode project

every-byte-counts commits `project.yml` and runs `xcodegen generate`. Shreddit
commits **no project at all** — Apple's `safari-web-extension-converter`
generates the container app + extension appex from `extension/` at build time.

That moves the generate-and-patch step into the Fastfile (`generate_project`), and
it has to fix six things the converter gets wrong or leaves unset:

1. **Bundle identifiers.** The converter builds the container app's
   `PRODUCT_BUNDLE_IDENTIFIER` from `--bundle-identifier`'s **prefix** plus
   `--app-name`, not from `--bundle-identifier` itself — so it invents an id that
   doesn't match the profiles. Back when `--app-name` was `Shreddit` this
   produced `com.ssalonen.Shreddit` (**capital S**) against a real id of
   `com.ssalonen.shreddit`, and that case mismatch broke Xcode's
   `ValidateEmbeddedBinary` prefix check and SideStore's re-signing (commit
   `8c1f2c9` patched it with `sed`).

   **Renaming did not retire this.** With `--app-name KeepScrolling` the
   converter now invents `fi.mailhub.KeepScrolling` against a real id of
   `fi.mailhub.keepscrolling` — capital `K` this time, same defect. Choosing an
   all-lowercase id does **not** avoid it, because the capitalisation comes from
   the converter's side, not ours.

   Both ids are therefore **set explicitly** via `xcodeproj` —
   `fi.mailhub.keepscrolling` and `fi.mailhub.keepscrolling.Extension` — rather
   than string-replaced. That makes the fix independent of the app's name and
   keeps the ids from drifting out of sync with the `Matchfile`. A `sed` that
   stops matching silently no-ops; an explicit assignment cannot. `verify_ipa`
   then asserts both ids on the shipped artifact, so if the converter ever
   changes this derivation again, the build fails instead of shipping.

2. **Signing.** The converter emits automatic signing with no team. The Fastfile
   stamps manual signing + the match profile onto each target after `match` runs.

3. **Versioning — this one is load-bearing for TestFlight.** The converter writes
   the literal `manifest.json` version (`"1.0"`) into each `Info.plist`, where an
   `xcargs MARKETING_VERSION` override is simply **ignored**. That was harmless
   before (the AltStore JSON took its version from the git tag, not from the
   IPA), but App Store Connect reads `CFBundleShortVersionString` /
   `CFBundleVersion` **from the Info.plist** and rejects duplicate build numbers
   — so every upload would have collided at `1.0`. `repoint_infoplist_versions`
   rewrites those keys to `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`
   so the tag version and the CI run number actually reach the binary.

4. **Export compliance.** The converter sets no `ITSAppUsesNonExemptEncryption`,
   so every uploaded build lands in App Store Connect as **"Missing
   Compliance"** and cannot reach testers until someone answers the encryption
   question by hand in the console — silently, *after* a green release. The
   Fastfile declares it as `NO`, which is the accurate answer: the content
   script only manipulates the DOM, and the app makes no network calls of its
   own. (If that ever changes — say the app starts talking to a server over
   anything but standard HTTPS — this declaration has to be revisited; it is a
   statement made to Apple, not a build flag.)

   Note this must be set as the `INFOPLIST_KEY_*` **build setting**, not just
   written into the `Info.plist` file, for the same reason as the display name
   below.

5. **The container app's UI.** The converter's app template is a single line of
   placeholder text ("You can turn on … in Settings") — and that page *is* the
   whole app the user sees on the home screen. `apply_app_ui` overwrites the
   template's `Main.html` with the one tracked in `app/` (a feature overview +
   the enable steps) and substitutes the build's version into the footer.

   It overwrites **in place**, never adds files: the generated project's file
   reference and Copy-Bundle-Resources phase already point at that path, so
   nothing has to be registered with `xcodeproj`. A new file would be copied and
   then silently *not* bundled.

   **`app/Main.html` is therefore one self-contained file** — CSS, JS and the
   app icon all inline. Two failed releases taught this the hard way, and both
   are worth keeping in mind before "tidying" the page back into sibling files:

   - **v0.5.0** assumed the app's web resources share a directory. They don't:
     the converter localizes the page, so `Main.html` is at
     `<App>/Resources/Base.lproj/Main.html` while other resources sit in
     `<App>/Resources/` above it. Worse, that split survives into the built
     bundle — localized resources land in `Base.lproj/` and plain ones at the
     `.app` root — so a relative `href` from the page to a sibling would not
     resolve at runtime even if the copy succeeded.
   - **v0.5.1** assumed the template's file set matched ours. It ships **no
     `Script.js` at all**, so there was nothing to overwrite.

   Both failed *loudly* in `apply_app_ui`, which is the point of the guard —
   nothing shipped. Files are located by globbing the generated project per
   filename, so no layout is hard-coded and the next rearrangement is absorbed
   rather than fatal; when a name resolves to zero or several files, the error
   lists every web resource the template did generate, so diagnosis takes one
   failed run rather than one per release.

   One sharp edge in the version stamp: the substitution rewrites **every**
   occurrence of `__APP_VERSION__` in the file. The page must contain exactly
   one (the footer) — an occurrence inside the inline script would be rewritten
   too, which is why the script detects an unsubstituted footer by shape
   (`/^Version\s/`) instead of comparing against the token. `test/extension.test.js`
   enforces the "exactly once" rule.

6. **The extension is referenced, not copied.** Two releases failed on the
   assumption that `build/gen` contains the extension's own files:

   - **v0.6.0** — `apply_build_info` globbed `build/gen` for `build-info.json`
     and found none. `report.js` reads that file through `runtime.getURL`, so
     no manifest entry names it, which made "the converter only copies what the
     manifest points at" a plausible story.
   - **v0.6.1** — the same glob for `manifest.json` found none *either*. That
     one is not explicable by manifest references: every shipped IPA contains
     it. The generated project simply keeps **no copy of `extension/`** — it
     references the tracked directory.

   `Dir.glob "**"` also does not descend into symlinked directories (nor does
   `Find.find`), so a symlinked `Resources` is indistinguishable from an absent
   one by search. Either way the conclusion is the same: **the filesystem under
   `build/gen` is not where the appex's resources live, and the project is the
   only authoritative source for that path.**

   `sync_extension_resources` therefore reads the appex target's Copy Bundle
   Resources phase, accepting either shape the converter might emit — a folder
   reference to a directory containing `manifest.json`, or a per-file reference
   to `manifest.json` itself. When that resolves outside `build/gen`, the tree
   is copied to `build/gen/ExtensionResources` and every reference into it is
   repointed, so stamping the version cannot rewrite a tracked file (which would
   dirty the working tree on a dev machine and make the build non-reproducible).

   Anything the project never registered is then copied in and **registered with
   `xcodeproj`**. That half matters for the same reason as (5) from the other
   side: a file merely copied into the generated tree is not bundled, and
   `apply_app_ui` only escapes it by overwriting a file the template already
   references. A second pass is a no-op, and a folder reference is left alone
   rather than given a duplicate per-file reference.

   `apply_build_info` is now handed that directory instead of searching for the
   file, and refuses outright if the path it is about to stamp resolves to the
   tracked `extension/build-info.json`.

Patching a generated project is safe **because it is a build artifact** under
`build/gen`, regenerated from scratch every run. This is the opposite of the bug
that broke every-byte-counts, where XcodeGen was writing over *tracked*
`.entitlements` files. There is no equivalent `git diff --exit-code` gate here
because nothing tracked is generated — but for the same reason, **never point the
converter at a path inside the repo that is under version control.**

## The verify gate

every-byte-counts verifies entitlements (it has an App Group to lose). Shreddit
has no entitlements to check, so `verify_ipa` asserts the invariants that a
converter change would actually break, **against the exported IPA** rather than
against the inputs that produced it:

1. exactly one `.app`, with `CFBundleIdentifier == fi.mailhub.keepscrolling`
2. exactly one embedded `.appex`, correctly nested under the app's id
   (the case-mismatch bug, now caught at build time instead of on device)
3. both carry the tag's version **and** this run's build number — otherwise ASC
   rejects the upload, or worse, accepts a mislabelled one
4. the app declares `ITSAppUsesNonExemptEncryption` — a missing value fails
   *open*: the upload succeeds and the build then sits in "Missing Compliance"
   until a human notices
5. `block-reddit-nag.js`, `block-x-nag.js`, and `manifest.json` are actually
   inside the appex
6. the container app bundles **our** `Main.html`, with the build's version
   stamped in and no leftover `__APP_VERSION__` placeholder

(5) is the one that matters most: a correctly signed, correctly versioned IPA
containing **no extension code** would sail through to TestFlight and simply do
nothing on device. (6) is the same failure mode one level down: if the converter
moves its app template, `apply_app_ui`'s copy lands somewhere unbundled and the
app quietly ships Apple's placeholder line instead. This is the reference repo's
central lesson — *a check whose expectation comes from the same source as the
thing being checked is not a check* — so all six read the shipped artifact.

## Secrets

Already present on this repo, unchanged:
`APPLE_TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
`APP_STORE_CONNECT_API_KEY_P8`.

**Must be added** (the `MATCH_*` trio, same values as every-byte-counts if the
signing repo is shared):

- `MATCH_PASSWORD` — passphrase encrypting the match repo.
- `MATCH_REPO_KEY` — **private** half of an SSH key registered as a **read**
  deploy key on the signing repo; loaded by `webfactory/ssh-agent`.
- `MATCH_GIT_URL` — the signing repo's SSH URL.

> **`secrets: inherit` was missing.** Both `ci.yml` and `bump-version.yml` call
> `release.yml` via `workflow_call`. Secrets do **not** cross `workflow_call`
> automatically — without `secrets: inherit` on the caller, every secret expands
> to `""` and fastlane dies with a cryptic error. This was latent before (the
> release needed no secrets) and is now fixed on both callers, with a
> fail-fast "Verify signing secrets are present" gate in `release.yml` that names
> exactly what is missing.

## One-time setup that must run on a Mac (not from CI)

These need a real macOS host and Apple portal access:

1. **Register the two App IDs** in the Developer portal (or let `match` create
   them): `fi.mailhub.keepscrolling` and `fi.mailhub.keepscrolling.Extension`.
   No special capabilities are required — a Safari web extension with no native
   messaging and no shared settings needs no App Group, which is why the
   entitlements apparatus from every-byte-counts is absent here.

2. **Create the app record in App Store Connect** for
   `fi.mailhub.keepscrolling`, named **Keep Scrolling**.
   `upload_to_testflight` uploads to an *existing* record and will fail if none
   exists. App Store names are globally unique, so if it is taken, pick another
   (e.g. `Keep Scrolling for Safari`) — the ASC name is independent of both the
   bundle ID and `APP_DISPLAY_NAME`, so nothing in this repo has to change.
   The old name "Shreddit" was dropped partly for this reason and partly because
   it is a play on "Reddit"; keeping a third-party brand out of the app name
   avoids review trouble under guidelines 4.1 / 5.2.1 if this ever goes beyond
   internal TestFlight.

3. **Reuse the shared signing repo.** The distribution cert is per Apple *team*
   and capped by Apple, so use the same repo as every-byte-counts (e.g.
   `ssalonen/ios-signing`) and just add Shreddit's two bundle IDs. Only split
   repos across different Apple teams, or for per-app access isolation — read
   access + `MATCH_PASSWORD` decrypts everything in the repo.

4. **Seed the profiles:**
   ```sh
   bundle install
   bundle exec fastlane certificates       # creates/stores cert + both profiles
   ```
   Commit the resulting `Gemfile.lock`.

5. **Add the three `MATCH_*` secrets** listed above.

6. **Verify locally before trusting CI:**
   ```sh
   MARKETING_VERSION=0.1.4 bundle exec fastlane build
   ```
   This runs the whole pipeline except the upload, including `verify_ipa`.

After that, every release runs `match --readonly` and never touches the portal.

### If App-ID capabilities ever change

Run the **Bump version and make a release** workflow with
`match_readonly: 'false'` to let `match` regenerate profiles from CI. Needs a
*write* deploy key in `MATCH_REPO_KEY` and an API key allowed to manage profiles.

## Open items

- **`Gemfile.lock` is not committed yet** — it cannot be generated in an
  environment without fastlane installed. `ruby/setup-ruby` with
  `bundler-cache: true` will resolve and lock on the first CI run, but commit the
  lock from step 4 above so CI and local machines are pinned identically.
- **Version floor.** `ci.yml` used to take `max(latest tag, altstore-source.json
  version)` so the version could only move forward. With the JSON gone, **git
  tags are the only version store** — `compute-version` therefore depends on
  `fetch-depth: 0` to see them all. Without the full history it would silently
  restart numbering at `v0.0.0`.
- **Migrating existing SideStore users.** Not handled. If that matters, the
  alternative is to keep `altstore-source.json` frozen at `v0.1.3` (rather than
  deleted) so existing installs keep resolving, and announce the move in its
  `news` field.
