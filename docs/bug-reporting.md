# In-Safari bug reporting — design and caveats

## Goal
Let a user who hits a nag the extension misses file a GitHub issue **from the
page it happened on**, with the diagnostic material that is otherwise
impossible to get off an iPhone: the page URL, the shipped build version, the
scroll-lock state, which nag signatures are still in the DOM, and a sanitized
copy of the page HTML.

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

## Nothing is uploaded
There is no API token, no POST, no third-party endpoint. The last step is
opening GitHub's own new-issue form with `title` and `body` prefilled; the user
reads the text and presses **Submit** themselves. The container app's "nothing
leaves your device" claim survives intact — the user is the transport, and the
one exception is spelled out on that screen.

`test/extension.test.js` fails if `report.js` ever grows an `XMLHttpRequest`, a
`POST`, a `sendBeacon`, an `Authorization` header, a second `fetch`, or any
remote URL besides the issue form.

## The URL budget
GitHub answers an over-long request line with **414**, well before the ~8 KB
most servers allow, so the prefilled URL is budgeted at `URL_BUDGET = 6000`
characters (URL-encoded, which inflates HTML by up to 3×).

`fitIssue()` shrinks the report until it fits, in a deliberate order:

1. the page-HTML block (the only unbounded part) is cut first;
2. only if the text alone still overflows is the whole body clipped.

So the user's own words, the version, and the page state always survive. When
anything was cut, the popup puts the **full** report on the clipboard, so it can
be pasted into the issue after GitHub opens. The Copy button does the same on
demand.

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
- `signatures` — counts and one sanitized sample per known nag selector, from
  the union of both scripts' signature lists (over-matching is harmless here:
  nothing is removed).
- `html` — `documentElement.outerHTML`, sanitized and capped at 120 000 chars
  before it crosses the message port.

## Redaction, and its limits
`sanitizeHtml()` strips `<script>` / `<style>` / `<textarea>` bodies, redacts
attributes whose *name* looks like a credential (`token`, `csrf`, `auth`,
`session`, `secret`, `password`, `api key`), redacts `<meta content="…">` on a
credential-named meta, blanks `<input value="…">`, and truncates long `data:`
URIs.

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

## Versioning
`extension/build-info.json` carries placeholders (`0.0.0-dev`) in the repo and
is rewritten by `stage_sources` (Fastfile) in the *staged* copy under `build/`
with the release version and CI build number; `verify_ipa` then asserts the
shipped appex really carries them. The tracked file is never written to, so a
local unstamped build correctly reports `0.0.0-dev`.

Getting the file into the build at all cost two releases, and the story is the
clearest example of why this repo stopped generating its Xcode project with
Apple's `safari-web-extension-converter`.

**v0.6.0** died with *"Expected exactly 1 build-info.json … found 0"*. The
explanation at the time: the converter copies what the **manifest** points at,
and nothing points at this file — `report.js` names it only at runtime, through
`runtime.getURL`. Declaring it in `web_accessible_resources` would have made the
converter copy it, at the cost of exposing it to every page for no other reason,
so `sync_extension_resources` copied in and registered whatever was missing.

**v0.6.1 then died the same way one glob further along** — *"Expected exactly 1
manifest.json … found 0"*, on a file every shipped IPA demonstrably contains.
That disproved the first explanation. The converter keeps **no copy of
`extension/` inside the generated project at all**: the project *references* the
tracked directory, directly or through a symlinked `Resources` — and `Dir.glob
"**"` does not descend into a symlinked directory, nor does `Find.find`. No
search under the generated tree was ever going to match. The fix was to stop
searching the filesystem and read the appex target's Copy Bundle Resources phase
instead, then copy the referenced tree somewhere private before stamping it,
because writing a version through a reference into `extension/` would have
rewritten the developer's own working tree.

Since v0.7.0 none of that exists. `project.yml` references a **staged copy** of
`extension/` as a group, so XcodeGen enumerates it at generate time and every
file gets bundled whether or not the manifest mentions it — and the paths the
build stamps are ours by construction rather than something to be discovered.
`stamp_target!` still refuses any write that resolves back into the tracked tree,
which is the one part of the v0.6.1 lesson that outlived the converter.
`verify_ipa` re-derives its expected file list from `extension/`, so a file that
fails to ship fails the release. `manifest.json`'s own `version` is now a
vestigial placeholder — the shipped versions come from `native/*/Info.plist`, and
nothing reads the manifest's copy.

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
  `execCommand('copy')` fallback, unverified on iOS.
- **Budget realism.** 6000 was chosen with headroom, not measured against
  GitHub's actual ceiling. If prefilled links start 414ing, lower it; the
  clipboard path is unaffected.
