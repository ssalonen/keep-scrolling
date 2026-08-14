# In-Safari bug reporting — design and caveats

## Goal
Let a user who hits a nag the extension misses file a GitHub issue **from the
page it happened on**, with the diagnostic material that is otherwise
impossible to get off an iPhone: which of the three known failures they saw,
the page URL, the shipped build version, the scroll-lock state, which nag
signatures are still in the DOM, what is pinned over the viewport, which
components the page loaded, and a sanitized copy of the page HTML.

Without this, every report is "it doesn't work on X" with no snapshot, and the
maintenance loop both nag scripts are built around — *capture a fresh HTML
snapshot, confirm the signature, extend the selector list* — cannot start.
iOS has no DOM inspector, so a user cannot produce that snapshot by hand.

## Where it lives
An extension **toolbar popup** (`action.default_popup` → `report.html`), reached
on iOS from Safari's address-bar **ᴀA** menu ▸ *Keep Scrolling*. That is the
only entry point that can see the page: the container app is a separate process
showing a local `Main.html` and has no access to Safari's DOM, and an in-page
button injected by a content script would be one more thing covering the
content the extension exists to uncover.

```
report.html ──▶ report.js ──(runtime message)──▶ collect-report.js  (the page)
                    │
                    ├── fetch build-info.json  (version stamped at build time)
                    └── tabs.create(github.com/…/issues/new?title=…&body=…)
```

## What leaves the device, and what does not
The issue is never filed on the user's behalf: the last step is opening
GitHub's own new-issue form with `title` and `body` prefilled, and the user
reads the text and presses **Submit** themselves. No token, no API call to
GitHub.

**One thing is uploaded**, and this reverses an earlier rule that said nothing
ever would. A GitHub issue body caps at 65 536 characters and cannot hold a
page snapshot; a report without a snapshot cannot start the maintenance loop
both nag scripts depend on. So the sanitized snapshot is POSTed to
`https://paste.rs/` and the issue links to it.

The trade is bounded deliberately:

- it happens **only** on the file button, **only** with the *Upload it and link
  from the issue* box ticked. Untick it and the old clipboard path is exactly
  what happens instead;
- the popup's preview — the consent step — shows a line saying the snapshot
  *will be* uploaded, in the place the snapshot would occupy;
- the checkbox names the service, says the link is readable by anyone who has
  it, and says retention is not guaranteed;
- the container app's privacy card says the same thing. All three must stay
  truthful together.

`test/extension.test.js` now pins the shape rather than forbidding the upload:
exactly two `fetch` calls (the packaged `build-info.json` and the upload),
exactly one `POST`, exactly two remote URLs (the issue form and the paste
host), the endpoint as a single named constant matching `host_permissions`, and
no `XMLHttpRequest`, `sendBeacon`, `Authorization` or `credentials:` anywhere.

### The Safari permission prompt (found on device)
The first real report filed from a device came back **with no snapshot link**,
and the user saw "a prompt whether to allow the extension for this site, for a
short moment" as the GitHub tab opened. Those are one bug:

1. Safari does **not** grant `host_permissions` at install. The first
   cross-origin request to paste.rs raises a per-site permission prompt.
2. A Safari popup is dismissed as soon as it loses focus. The prompt takes
   focus, so the popup — and the JavaScript context running the upload — is
   destroyed while `fetch` is still in flight.
3. The upload therefore never resolves, the issue opens with no link, and the
   only trace is a prompt that flashed past on the way to GitHub.

The fix is to stop letting the *fetch* raise that prompt:

- the popup checks `permissions.contains()` on open and, when the grant is
  missing, shows a **standalone "Allow paste.rs" button** with an explanation.
  Losing the popup to the prompt then costs nothing — no report is in flight —
  and the grant persists, so the next filing just works;
- the file button still asks first if the grant is missing, and skips the
  upload entirely when it is refused rather than firing a request that cannot
  succeed;
- both paths fall back to the clipboard, as before.

Every branch is recorded **in the issue body** (`uploadOutcome`): *declined by
the reporter*, *not allowed by Safari*, or *attempted but failed*. Without that
line, a report with no link looks the same whichever happened, and the
difference is the entire diagnosis — the reporter exists precisely because the
person filing cannot be asked to diagnose it.

`permissions.contains`/`request` are treated as optional: a host without the
API answers `unknown`, and the code falls through to attempting the upload,
which is exactly the behaviour that shipped in v0.8.0.

### Why paste.rs, and what it demands of the code
Chosen over the alternatives because it takes a raw `POST` body with no account
and no API key (a key baked into a public client is a shared secret), returns
the URL as plain text, and supports `DELETE`. GitHub Gist was the obvious
"reputable" option and is unusable: anonymous gists were removed in 2018.

Four measured properties the code has to respect — none of them documented:

- **393 216 bytes (384 KiB) is the ceiling.** Past it the host answers `206`
  and stores the paste **cut from the front** — the one cut that loses a
  late-injected nag. So `trimToBytes()` middle-cuts to fit *before* posting,
  measuring **bytes**: a snapshot is not ASCII and a character count overshoots.
  A `206` is still reported as partial in the issue.
- **`/<id>.html` renders the paste as HTML.** Linking that would serve a
  captured page from the host's origin, so the returned URL has any extension
  stripped and is linked plain.
- **No `Access-Control-Allow-Origin`, and `OPTIONS` 404s.** The request must
  stay CORS-simple (`Content-Type: text/plain`), and `host_permissions` is what
  lets the popup read the response at all.
- **"Pasting is heavily rate limited."** Failure is expected, so every path
  falls back to the clipboard with a status message rather than losing the
  report.

The response is validated before it reaches the issue body: only a URL on the
host that was posted to, with no whitespace, is accepted.

## What the user is asked
Three checkboxes and a text box. The checkboxes (`SYMPTOMS` in `report.js`) are
the three ways the extension actually fails — *the nag is still visible*, *the
page will not scroll*, *an overlay covers the whole page* — plus *something
else*. They exist because the two halves come apart: a visible nag with a
working page and a frozen page with nothing on it are different bugs in
different code, and the third is the pair at once. A user who taps two boxes has
filed something more useful than one who types nothing.

Ticking a box also seeds the issue title, so a report about a frozen page does
not arrive titled "nag not removed"; the title stops following the boxes as soon
as the user edits it. The checkboxes are rendered from `SYMPTOMS` at runtime
rather than written into `report.html`, so the label a user taps and the line
the issue gets cannot drift apart — the test suite fails if a label is
duplicated into the page.

## The URL budget
GitHub answers an over-long request line with **414**, well before the ~8 KB
most servers allow, so the prefilled URL is budgeted at `URL_BUDGET = 6000`
characters (URL-encoded, which inflates HTML by up to 3×).

That budget holds roughly 2 000 characters of report, and the page HTML alone
runs to six figures — so the URL was never going to be the transport for it.
**The clipboard is.** `fitIssue()` drops whole sections until the rest fits, in
increasing order of usefulness:

1. the page HTML;
2. the matched-signature markup (a subset of that same HTML);
3. the overlay/component summary;
4. the lock and signature counts;
5. only then is the remaining text clipped.

Sections go **whole**, not nibbled down. Half a page snapshot is the top of
`<head>` — link tags and meta, never the nag, which sits deep in `<body>`; it
would spend the entire budget and still be undiagnosable. A JSON block cut
mid-key is worse. What survives is a shorter but complete report.

When the page HTML is dropped, the issue body says so **in place of it** and
points at the clipboard, which the popup loads with the untruncated report
whenever anything was cut. Without that line the issue reads like a finished
report that merely lacks a snapshot, and nobody pastes anything. The Copy
button does the same on demand.

`describeSnapshot()` splits the page details into those tiers deliberately, and
sizes the middle one to survive: the overlay list is trimmed to the three
biggest covers with the opening tag capped at 160 characters, because a
diagnostics block that gets dropped on every real page is the same as never
having collected it. A test measures a realistic X-status-page report end to
end and fails if the lock state or the overlay summary stops fitting.

## The issue-body limit — what the fallback still has to handle
With the upload in place the snapshot travels as a link, and the trimming below
applies only when the user unticks the upload box or the host is unreachable.
It is still the path a report takes on a bad day, so it stays exercised and
tested.


The clipboard is the transport, but it is **not** an unbounded one. GitHub
rejects an issue body over **65 536 characters** outright:

```
Body can not be longer than 65536 characters
```

That is a server-side validation on the pasted text, so it applies no matter
how the body arrives. The first version of this reporter budgeted the URL and
treated the clipboard as unlimited, which produced a copy of up to 400 KB —
one that could not be pasted at all. A snapshot that cannot be pasted is worth
no more than one that was never captured.

So `fitClipboard()` budgets the copy at `BODY_BUDGET = 65000`, and the popup
shows and copies exactly that fitted text — the preview is what will paste.
Both paths share one `shrink()`, differing only in what they measure: the
prefilled link measures `issueUrl(...).length`, the clipboard measures the
body's own length.

### Why the page HTML is cut from the middle
In the clipboard path the HTML is **trimmed, not dropped** — there is room for
tens of thousands of characters of it — and the cut takes the **middle**,
keeping both ends, because that is where the evidence is:

- `<head>` holds the `modulepreload` names and injected stylesheets. Both
  diagnoses in `docs/` started there (`logged-out-open-app-banner`, `vaul`).
- the nags themselves are appended **late in `<body>`** — Reddit's blocking
  sheet, X's app-store modal, X's drawer.

A plain prefix keeps `<head>` and loses the nag, which is the whole report.
The cut is marked in place so nobody reads the join as the page's real markup.

`collect-report.js` clamps the same way (`clampDocument()`) when the document
exceeds its own 400 000-character port cap — for exactly the same reason, one
level up. A head-first `truncate()` there would throw away the end of `<body>`
before `report.js` ever saw it, capping the snapshot to the one part of the
document that never contains what is being reported.

## What the snapshot contains, and why
`collect-report.js` is a third content script on the same hosts as the two nag
scripts. It **reads only** — the test suite fails on `.remove()`,
`setAttribute`, `classList`, `appendChild` or `innerHTML =` appearing in it —
so a bug in the reporter can never break browsing.

- `scriptsActive` — whether `#rnr-style` / `#xnr-style` (the stylesheets the nag
  scripts inject) are present. This is the single most valuable field: the
  snapshot is taken *after* the nag scripts ran, so a healthy report shows zero
  signature matches, and without this marker "clean page" and "the extension
  never ran" (disabled, or not allowed on this site) look identical.
- `lock` — `<html>`/`<body>` classes, inline styles, computed
  `overflow`/`position`/`touch-action`/`pointer-events`, and whether the page
  can actually scroll. That is the half of the problem the user feels.
- `lock.maxScroll` / `lock.screens` — how far the page can travel, and how much
  page there is. `scrollable` is a boolean satisfied by 4px, and issue #28 was a
  page with 590px of scroll in it: the extension had released everything there
  was to release, and the reader still reported that it would not scroll,
  because 1.7 screens is what the whole page amounted to — the post, three
  replies, and two `role="status"` placeholders that never filled in. "It is
  locked" and "there is nothing to scroll to" are different bugs, in different
  code, and a boolean cannot tell them apart.
- `lock.pan` — what is under the middle of the viewport, and the first element
  in its ancestor chain whose computed `touch-action` forbids a vertical drag.
  `scrollable` only compares document height to viewport height, and the two
  come apart: issue #25 was a full-screen `touch-action: none` cover over a page
  reporting `scrollable: true`, `overflow: visible` and no lock on either
  element. The report was *complete* and every field in it said the page was
  fine. This is the field that names that element instead.
- `signatures` — counts and one sanitized sample per known nag selector, from
  the union of both scripts' signature lists (over-matching is harmless here:
  nothing is removed). It also carries `[data-vaul-drawer]`, which neither
  script removes — a page locked by a drawer we have no selector for is exactly
  the case this reporter exists for — and `[data-base-ui-scroll-locked]`, the
  marker the library X moved onto after `vaul` sets while its lock is in force.
  That one names the lock itself, which no amount of `html`/`body` inline style
  can reveal once the nag script has already cleared it. `[data-xnr-hidden]` is
  in the list for the opposite reason: it says what the X script *did* match, so
  "we never recognised it" and "we hid it and it is still on screen" stay
  distinguishable in a report.
- `overlays` — every **pinned element covering ≥10 % of the viewport**, biggest
  first: its opening tag, computed `z-index`/`pointer-events`/`touch-action`,
  and its visible text. Every nag either script has had to remove is that
  shape, so this names an *unrecognised* one — turning "the whole page is
  covered by something" into a selector someone can write. The scan touches
  every element on the page, so it is capped (`OVERLAY_SCAN_LIMIT`) and runs
  only when the popup asks.
- `components` — the module names the page preloads, with the content hash
  stripped (`logged-out-open-app-banner-D4f8Xq2b.js` → `logged-out-open-app-banner`).
  Both diagnoses in `docs/` started here: that name identified X's banner, and
  `vaul`'s stylesheet identified the scroll lock, before either was matched in
  the DOM. A few hundred bytes, so they reach the issue even when the page HTML
  cannot.
- `html` — `documentElement.outerHTML`, sanitized and capped at 400 000 chars
  before it crosses the message port. The cap is generous because the clipboard
  carries this, not the URL, and a snapshot cut off inside `<head>` is not
  something anyone can diagnose from.

## Redaction, and its limits
`sanitizeHtml()` strips `<script>` / `<style>` / `<textarea>` bodies, redacts
attributes whose *name* looks like a credential (`token`, `csrf`, `auth`,
`session`, `secret`, `password`, `api key`, `nonce`), redacts the `content` of
**every** `<meta>`, blanks `<input value="…">`, and truncates long `data:` URIs.

### Why every `<meta>`, not just credential-shaped ones
Redacting `<meta>` on a credential-shaped *name* only ever caught the honest
cases — `csrf-token` announces itself. The head is also where a page parks its
CSP nonce, its Sentry trace and baggage ids, request ids and build hashes,
under names no pattern predicts, and a bug report carries them into a public
issue. The exchange is free: `<meta>` content is of no use in diagnosing a nag,
which lives in the `<body>` and is found by structure. So the default flipped —
everything is redacted except a short allowlist (`viewport`, `charset`,
`color-scheme`, `theme-color`, `referrer`, `robots`, `generator`) that describes
how the page lays itself out and can hold nothing session-specific.

The same reasoning added `nonce` to the credential names: a CSP nonce rides on
the tags themselves, not only on a meta.

It is **best-effort, not a security boundary**: the HTML of a logged-in session
inevitably contains that session's content, and it can't be redacted away
without destroying the diagnostic value. The design compensates by keeping the
user in the loop — the popup states that GitHub issues are public, shows the
exact text before anything is sent, and the HTML block is a checkbox the user
can switch off.

Each pattern matches one tag or one attribute and decides in a callback, rather
than chaining `[^>]*` runs across a tag: the same result with no ambiguous
backtracking over a megabyte of page HTML.

Two shapes look like pedantry and are not — both leak exactly what the function
exists to remove, and the tests cover both:

- browsers accept junk inside an end tag (`</script >`, `</style foo>`), so the
  end-tag patterns are `<\/script\b[^>]*>`, not a literal `</script>`. CodeQL
  flags the literal version as `js/bad-tag-filter`.
- a quoted attribute value can contain `>` (`content="a > b"`), which ends a
  `[^>]*` run early and leaves the rest of the tag unredacted — so the `<meta>`
  and `<input>` passes walk attributes quote-aware.

## Headless regression run
The whole loop is DOM-only, so it can be driven in a desktop browser without a
device: load a fixture page with the collector injected and a stub
`runtime.onMessage`, ask it for a snapshot, then open `report.html` with a
stubbed `browser.tabs` and click **Open GitHub issue**. That run is what caught
the diagnostics block being silently dropped from every prefilled URL for being
2.7 KB — the unit tests passed the whole time, because each part worked and only
the sizes were wrong. Worth repeating after any change to the sections or the
budget: assert the secrets in the fixture do not appear in the snapshot, and
that the opened URL is under budget with the lock state and overlay summary
still in it.

## Versioning
`extension/build-info.json` carries placeholders (`0.0.0-dev`) in the repo and
is rewritten in the *generated* project by `apply_build_info` (Fastfile) with
the release version and CI build number; `verify_ipa` then asserts the shipped
appex really carries them.

Finding the file to stamp took two failed releases to get right. The first
attempt globbed `build/gen` for it and died with *"Expected exactly 1
build-info.json … found 0"*; the fix for that globbed for `manifest.json`
instead, and died the same way — on a file every shipped IPA contains.

That second failure is the diagnosis: **the generated project holds no copy of
`extension/` at all.** It references the tracked directory, so nothing under
`build/gen` was ever going to match. (A symlinked `Resources` would look the
same from the outside: `Dir.glob "**"` does not descend into symlinked
directories, and neither does `Find.find`.)

So `sync_extension_resources` stopped searching the filesystem and asks the
appex target's Copy Bundle Resources phase where its resources come from —
either a folder reference to a directory holding `manifest.json`, or a per-file
reference to `manifest.json` itself. If that resolves outside `build/gen`, the
tree is copied to `build/gen/ExtensionResources` and every reference into it is
repointed, because stamping a version through a reference to the tracked file
would rewrite the working tree on a dev machine. Anything the project never
registered is then copied in and registered with `xcodeproj` — copying alone
would not be enough, since an unreferenced file is never bundled, the same trap
`apply_app_ui` avoids by overwriting the template's own files in place. `manifest.json`'s own `version` is deliberately left
alone — the converter reads it on the way to `Info.plist`, which
`generate_project` repoints at the build settings, and rewriting it after
conversion would leave the two disagreeing.

Without the stamp, every report from every release would name the same version
and be useless for bisecting a regression.

## Caveats / things to verify on-device
- **Popup reachability.** Safari on iOS surfaces extension popups from the ᴀA
  menu; this has not been checked on a device for this build. If the action
  never appears, the fallback is a content-script-injected affordance, which is
  a bigger and more intrusive change.
- **`activeTab` and messaging.** `tabs.sendMessage` needs the collector to be
  running in the tab, which needs the site to be *allowed* in Safari's
  per-site settings. When it isn't, the popup degrades to a report with no page
  details rather than failing — worth confirming that degradation actually
  looks like that on device, and not like an empty sheet.
- **Clipboard.** `navigator.clipboard.writeText` from an extension popup should
  work in a secure context under a user gesture; there is an
  `execCommand('copy')` fallback, unverified on iOS. This now carries more
  weight than it used to: the page HTML reaches the issue **only** through the
  clipboard. If it turns out not to work on iOS, the fallback worth trying is
  a second tab with the snapshot in a `<textarea>` for the user to select.
- **Budget realism.** 6000 was chosen with headroom, not measured against
  GitHub's actual ceiling. If prefilled links start 414ing, lower it; the
  clipboard path is unaffected. The *body* limit, by contrast, is not a guess —
  65 536 is GitHub's own error message, hit in practice on the first real
  report filed with this reporter.
- **Overlay scan cost.** `collectOverlays()` calls `getComputedStyle()` on up
  to 8 000 elements. Measured only in a desktop headless run, where it is
  imperceptible; on an older iPhone it may be a visible pause between opening
  the popup and the sheet filling in. If so, cut `OVERLAY_SCAN_LIMIT` or scan
  only `document.body`'s first few levels of children — the nags we know of are
  all shallow.
- **Overlay noise.** The scan reports what is pinned over the page, including
  X's cookie-consent banner. That is correct — it is read-only reporting, not
  removal — but a reader of an issue should not mistake the list for a list of
  things to remove.
- ~~**The upload has never run on a device.**~~ It has now, and it failed, in
  the way described below. See "The Safari permission prompt".
- **Retention is undocumented.** paste.rs states no expiry policy, so a link in
  an old issue may or may not resolve months later. The issue text says as much
  rather than implying permanence. If snapshots start disappearing before they
  are acted on, the answer is to attach them to the issue instead — or to go
  back to compressing them into the body (gzip+base64 measured at ~4.7× on
  prose HTML, likely 6–10× on app markup, i.e. roughly 300–450 KB inside the
  65 536-character limit).
- **Third-party exposure.** The snapshot is sanitized best-effort, and a
  logged-in page's HTML still contains that session's content. Uploading it
  puts that on someone else's server, readable by anyone with the link, in
  addition to the GitHub issue being public. That is the deliberate trade for
  getting a whole snapshot; the checkbox is how a user declines it.
