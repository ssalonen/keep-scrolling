// report.js
// Popup logic for the "Report a problem" sheet (report.html).
//
// It asks the collector content script for a snapshot of the current page,
// formats it together with the symptoms the user ticked, whatever they typed
// and the shipped build version, and hands the result to GitHub as a PREFILLED
// new-issue URL.
//
// Design notes:
//  - The issue itself is never submitted from here: the last step is opening
//    github.com's own /issues/new page with title+body in the query string,
//    which the user reads and submits themselves. No token, no API call to
//    GitHub.
//  - ONE thing does leave the device, and only on the file button, only with
//    the upload box ticked: the sanitized page snapshot is POSTed to
//    SNAPSHOT_ENDPOINT and the issue links to it. This replaced the earlier
//    "nothing is ever uploaded" rule deliberately — a GitHub issue body caps
//    at 65 536 characters, which cannot hold a page snapshot, and a report
//    without one cannot start the maintenance loop either script depends on.
//    The trade is stated on the checkbox, in the preview, and in the container
//    app's privacy section; keep all three truthful. Untick it and the old
//    clipboard path is exactly what happens.
//  - GitHub answers an over-long request line with 414, so the prefilled URL is
//    budgeted (URL_BUDGET) and fitIssue() drops whole sections until it fits,
//    page HTML first. The page HTML realistically never fits, so the full
//    report always goes to the clipboard and the issue body says where to paste
//    it — a report without the snapshot cannot be acted on.
//  - The version comes from build-info.json, which the Fastfile stamps at
//    build time (manifest.json's own version is a fixed placeholder the
//    converter only reads on the way to Info.plist). Without it every report
//    would claim the same version and be useless for bisecting a regression.

'use strict';

const api = globalThis.browser || globalThis.chrome;

const REPO = 'ssalonen/keep-scrolling';
const NEW_ISSUE_URL = `https://github.com/${REPO}/issues/new`;
const COLLECT_MESSAGE = 'keep-scrolling:collect';

// The one endpoint this extension ever sends anything to, and only when the
// user ticks the upload box and then presses the file button. A GitHub issue
// body caps at 65 536 characters, which cannot hold a page snapshot, so the
// snapshot goes here and the issue links to it.
//
// paste.rs: POST the raw bytes, get a URL back. No account, no API key, and
// `DELETE <url>` removes a paste. Measured behaviour that this code depends on:
//   - 201 CREATED  = the whole paste was stored;
//   - 206 PARTIAL  = it exceeded the server limit and was stored TRUNCATED,
//                    from the front — the same head-first cut that loses the
//                    nag, so we pre-trim and still report a 206 as partial;
//   - the ceiling is 393 216 bytes (384 KiB), measured, not documented;
//   - "pasting is heavily rate limited", so failure is expected and must
//     degrade to the clipboard rather than lose the report.
const SNAPSHOT_ENDPOINT = 'https://paste.rs/';
const UPLOAD_MAX_BYTES = 393216;

// Match pattern for the same host, for the permissions API. Safari does NOT
// grant host permissions at install: the first cross-origin request raises a
// per-site prompt — and a Safari popup is dismissed the moment it loses focus,
// so the prompt kills the popup, the in-flight fetch never resolves, and the
// issue arrives with no snapshot link. Asking for the grant on its own button,
// before the report is filed, is what makes that survivable: losing the popup
// to the prompt then costs nothing, and the grant persists for next time.
const SNAPSHOT_ORIGIN = 'https://paste.rs/*';

// The shape of a paste path, anchored at both ends: `/AbC12`, optionally with
// a format extension. Anchoring is the point — an unanchored check would pass
// on any path that merely contains an id-like run.
const PASTE_PATH = /^\/[A-Za-z0-9]{1,32}(\.[A-Za-z0-9]{1,8})?$/;

// Retention is undocumented, so the issue says so rather than implying the
// link is permanent.
const UPLOAD_NOTE = 'uploaded by the reporter — public to anyone with the link, retention not guaranteed';

// GitHub 414s on a long request line well before the 8 KB most servers allow;
// stay comfortably under it, since the URL also has to survive being handed to
// Safari.
const URL_BUDGET = 6000;

// The handful of things that actually go wrong, as a multi-select. A user who
// taps two boxes gives a more useful report than one who types nothing, and
// these three are what the two nag scripts fail at: a nag we did not remove, a
// scroll lock we did not release, and an overlay we did not recognise (which
// is the pair happening at once, and points somewhere different).
//
// `title` seeds the issue title; `label` is what the issue body says.
const SYMPTOMS = [
  { id: 'nag', title: 'Nag still visible', label: 'The nag or pop-up is still visible' },
  { id: 'scroll', title: 'Page will not scroll', label: 'The page will not scroll' },
  { id: 'overlay', title: 'Overlay covers the page', label: 'An overlay covers the whole page' },
  { id: 'other', title: 'Problem', label: 'Something else (see the description)' },
];

// How much of the collector's overlay list goes into the prefilled URL. It is
// the block that has to survive the trim on a real page — the untrimmed list
// is in the clipboard copy — so it is kept to roughly a third of the budget.
const ISSUE_OVERLAYS = 3;
const ISSUE_TAG_LIMIT = 160;
const ISSUE_TEXT_LIMIT = 80;

// The page HTML is the one part that never fits a prefilled URL (see fitIssue).
// Say so in the issue itself, so the report reads as "paste pending" rather
// than as a complete report that happens to be missing its snapshot.
const HTML_OMITTED_NOTE = '_The sanitized page HTML did not fit in the prefilled link — '
  + 'it is on the clipboard. **Paste it here before submitting.**_';

// GitHub rejects an issue body over 65 536 characters outright, so the
// clipboard copy is budgeted as well — with headroom, because the limit is
// counted server-side on the decoded text and there is nothing to gain from
// sitting on the boundary.
const BODY_BUDGET = 65000;

// Room left for the truncation marker itself, and the smallest page-HTML
// fragment worth keeping rather than dropping the block outright.
const HTML_CUT_SLACK = 240;
const HTML_MIN_KEEP = 2000;

// How the kept part of an over-long snapshot is split between the two ends.
// `<head>` is the smaller share: it is the same few kilobytes of preloads and
// stylesheets on every page, while the tail is where a late-injected nag lands.
const HTML_HEAD_SHARE = 0.25;

// Cut the middle out of an over-long snapshot, keeping both ends and saying so
// where the cut is, so nobody reads the join as the page's real markup.
function trimMiddle(html, keep) {
  if (typeof html !== 'string' || html.length <= keep) return html || '';
  const head = Math.floor(keep * HTML_HEAD_SHARE);
  const tail = keep - head;
  const cut = html.length - keep;
  return `${html.slice(0, head)}\n…[${cut} characters cut from the middle to fit GitHub's `
    + `65536-character issue body — both ends kept]…\n${html.slice(html.length - tail)}`;
}

// ── Report formatting (pure — kept top-level so the tests can drive it) ──────

function truncate(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text || '';
  return `${text.slice(0, limit)}\n…[truncated]`;
}

// Fenced blocks hold page HTML, which can itself contain a fence.
function fence(language, text) {
  return ['```' + language, String(text).replace(/```/g, '``​`'), '```'].join('\n');
}

function formatEnvironment(env) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `- **${key}:** ${String(value).replace(/\n/g, ' ')}`)
    .join('\n');
}

function buildBody(parts) {
  const {
    symptoms, description, environment, pageState, diagnostics, samples,
    html, htmlNote, htmlOmitted, htmlLink, htmlPending, htmlPartial, uploadOutcome,
  } = parts;
  const chosen = symptoms || [];
  const text = (description || '').trim();
  const sections = [];

  if (chosen.length) {
    sections.push('### What happened', '', chosen.map((symptom) => `- ${symptom.label}`).join('\n'), '');
  }
  if (text) sections.push(text, '');
  else if (!chosen.length) sections.push('_No description provided._', '');

  sections.push('### Environment', '', formatEnvironment(environment || {}));

  if (pageState) {
    sections.push('', '### Page state', '', fence('json', pageState));
  }

  if (diagnostics) {
    sections.push('', '### Overlays and components', '', fence('json', diagnostics));
  }

  if (samples) {
    sections.push(
      '',
      '<details><summary>Matched signatures (sanitized)</summary>',
      '',
      fence('json', samples),
      '',
      '</details>',
    );
  }

  // The snapshot reaches the issue one of three ways, in descending order of
  // usefulness: a link to the uploaded copy (whole page, nothing trimmed), the
  // HTML inline (only what the budget allows), or a note saying it is on the
  // clipboard. `htmlPending` is the preview's version of the first — the
  // upload has not happened yet, and the preview must say what will be sent.
  if (htmlLink) {
    sections.push(
      '',
      '### Page HTML',
      '',
      `[Full sanitized page snapshot](${htmlLink}) — ${UPLOAD_NOTE}.`,
    );
    if (htmlPartial) {
      sections.push('', '_The snapshot exceeded the paste host\'s size limit; the middle was cut._');
    }
    if (htmlNote) sections.push('', htmlNote);
  } else if (htmlPending) {
    sections.push(
      '',
      '### Page HTML',
      '',
      '_The page snapshot will be uploaded when you press “Open GitHub issue”, and linked here._',
    );
    if (htmlNote) sections.push('', htmlNote);
  } else if (html) {
    sections.push(
      '',
      '<details><summary>Page HTML (sanitized)</summary>',
      '',
      fence('html', html),
      '',
      '</details>',
    );
    if (htmlNote) sections.push('', htmlNote);
  } else if (htmlOmitted) {
    sections.push('', '### Page HTML', '', HTML_OMITTED_NOTE);
    // Why there is no link, recorded in the issue itself. Without this the
    // report looks identical whether the user declined the upload, Safari
    // never allowed it, or the host was down — and the difference is the
    // whole diagnosis.
    if (uploadOutcome) sections.push('', `<sub>Snapshot upload: ${uploadOutcome}.</sub>`);
  }

  sections.push('', '<sub>Filed from the Keep Scrolling Safari extension.</sub>');
  return sections.join('\n');
}

function issueUrl(title, body) {
  const url = new URL(NEW_ISSUE_URL);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  return url.toString();
}

// BOTH destinations are bounded, and neither bound is ours to negotiate: the
// prefilled link dies at GitHub's request-line limit, and a pasted issue body
// is rejected outright over 65 536 characters. So both go through the same
// shrink, differing only in what they measure.
//
// Sections go whole rather than being nibbled down: a JSON blob cut mid-key is
// worse than no blob at all. The page HTML is the one exception, and only in
// the clipboard path — see fitClipboard.
const SECTION_ORDER = ['samples', 'diagnostics', 'pageState'];

function shrink(parts, budget, measure) {
  let body = buildBody(parts);
  if (measure(body) <= budget) return { body, truncated: false };

  // Drop whole sections in increasing order of usefulness: the matched markup
  // (a subset of the page HTML), then the overlay/component summary, then the
  // lock state. Past there the symptoms, the user's own words and the version
  // are all that is left, and they are the point.
  const kept = { ...parts };
  for (const section of SECTION_ORDER) {
    if (!kept[section]) continue;
    kept[section] = '';
    body = buildBody(kept);
    if (measure(body) <= budget) return { body, truncated: true };
  }

  // Nothing structured left to drop: the typed description itself is huge.
  // Clip the body — a filed-but-shortened issue beats a rejected one. Convert
  // the overshoot through the ratio the measure itself reports (about 3× for a
  // URL-encoded body, 1× for a pasted one) so the loop shrinks by a useful
  // amount rather than nibbling one character at a time.
  let size = measure(body);
  while (size > budget) {
    const ratio = Math.max(1, size / body.length);
    const keep = body.length - Math.ceil((size - budget) / ratio) - 64;
    body = truncate(body, Math.max(200, keep));
    size = measure(body);
    if (keep < 200) break;
  }
  return { body, truncated: true };
}

// The prefilled link. The page HTML never fits a request line — the budget
// holds about 2 000 characters of report — so it goes first and goes whole,
// with a note in its place pointing at the clipboard copy.
function fitIssue(title, parts, budget) {
  const measure = (body) => issueUrl(title, body).length;

  const whole = buildBody(parts);
  if (measure(whole) <= budget) return { body: whole, url: issueUrl(title, whole), truncated: false };

  const { body } = shrink({ ...parts, html: '', htmlOmitted: !!parts.html }, budget, measure);
  return { body, url: issueUrl(title, body), truncated: true };
}

// The clipboard copy — the one the user actually pastes. GitHub rejects a body
// over 65 536 characters ("Body can not be longer than 65536 characters"), so
// this is budgeted too: a snapshot that cannot be pasted is worth no more than
// one that was never captured.
//
// Here the page HTML is *trimmed* rather than dropped, because there is room
// for tens of thousands of characters of it. It is cut from the MIDDLE,
// keeping both ends, since that is where the evidence is: `<head>` holds the
// preloaded module names and injected stylesheets that named both variants in
// docs/, and the nags themselves are appended late in `<body>`. A plain prefix
// would be all `<head>` and no nag.
function fitClipboard(parts, budget) {
  const body = buildBody(parts);
  if (body.length <= budget) return { body, truncated: false };

  const html = parts.html || '';
  if (html) {
    // What the rest of the report costs, measured with the HTML block present
    // but empty, so the fence and <details> wrapper are counted.
    const room = budget - buildBody({ ...parts, html: ' ' }).length - HTML_CUT_SLACK;
    if (room > HTML_MIN_KEEP) {
      const trimmed = buildBody({ ...parts, html: trimMiddle(html, room) });
      if (trimmed.length <= budget) return { body: trimmed, truncated: true };
    }
  }

  const { body: shrunk } = shrink(
    { ...parts, html: '', htmlOmitted: !!html }, budget, (text) => text.length,
  );
  return { body: shrunk, truncated: true };
}

// Seeded from the first symptom the user ticked, so a report about a frozen
// page does not arrive titled "nag not removed".
function defaultTitle(url, symptoms) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  const lead = (symptoms && symptoms.length && symptoms[0].title) || 'Nag not removed';
  return host ? `${lead} on ${host}` : lead;
}

// The collector's snapshot → the two report sections. Kept separate from
// buildBody so the formatting is testable without a DOM.
function describeSnapshot(snapshot, buildInfo) {
  const environment = {
    'Keep Scrolling': buildInfo.version
      ? `${buildInfo.version}${buildInfo.build ? ` (${buildInfo.build})` : ''}`
      : 'unknown',
    Page: snapshot.url || '(unknown)',
    'User agent': snapshot.userAgent || navigator.userAgent,
    Viewport: snapshot.viewport,
    'Content script ran': snapshot.scriptsActive
      ? Object.entries(snapshot.scriptsActive)
        .filter(([, active]) => active)
        .map(([site]) => site)
        .join(', ') || 'no'
      : 'unknown',
    'Page scrollable': snapshot.lock ? String(snapshot.lock.scrollable) : undefined,
  };

  // Three blocks, not one, because the trim drops whole sections and the
  // prefilled URL only has room for about two. Smallest and most valuable
  // first: `pageState` is the lock plus a selector→count tally, `diagnostics`
  // is a trimmed list of what is covering the page, and the bulky matched
  // markup goes last in `samples`, where it is dropped first.
  const signatures = snapshot.signatures || [];
  const counts = {};
  for (const found of signatures) counts[found.selector] = found.count;

  // Flattened out of the collector's element list: the same facts, minus the
  // wrapper keys, which is a few hundred URL-encoded characters saved on the
  // one block that must never be the thing that gets dropped.
  const lock = snapshot.lock && {
    scrollable: snapshot.lock.scrollable,
    // Whether a finger can actually pan the page, which `scrollable` does not
    // answer — a full-screen touch-action:none cover leaves every other field
    // in this block reading "healthy". See collect-report.js.
    pan: snapshot.lock.pan,
    ...Object.fromEntries((snapshot.lock.elements || []).map((el) => [
      el.element,
      el.present ? { class: el.class, style: el.style, ...el.computed } : 'absent',
    ])),
  };

  const pageState = lock || signatures.length
    ? JSON.stringify({ lock, signatures: counts }, null, 2)
    : '';

  // Trimmed to fit: the point of this block is that it survives the URL trim,
  // and the untrimmed version is in the clipboard copy either way.
  const overlays = (snapshot.overlays || []).slice(0, ISSUE_OVERLAYS).map((overlay) => ({
    ...overlay,
    tag: truncate(overlay.tag, ISSUE_TAG_LIMIT),
    text: truncate(overlay.text, ISSUE_TEXT_LIMIT),
  }));
  const components = snapshot.components || [];
  const diagnostics = overlays.length || components.length
    ? JSON.stringify({ overlays, components }, null, 1)
    : '';

  const matched = signatures.filter((found) => found.sample);
  const samples = matched.length ? JSON.stringify(matched, null, 1) : '';

  return { environment, pageState, diagnostics, samples };
}

// The paste host's ceiling is in BYTES, and a page snapshot is not ASCII, so
// trimming by character count would overshoot and hand back a 206 — a paste
// silently cut from the front, which is the one cut that loses the nag.
// Convert through the measured bytes-per-character ratio, then verify.
function trimToBytes(html, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(html).length <= maxBytes) return html;

  const ratio = encoder.encode(html).length / html.length;
  let keep = Math.floor(maxBytes / ratio) - 200;
  let trimmed = trimMiddle(html, keep);
  while (encoder.encode(trimmed).length > maxBytes && keep > 1000) {
    keep = Math.floor(keep * 0.9);
    trimmed = trimMiddle(html, keep);
  }
  return trimmed;
}

// The only outbound request this extension makes, and only from the file
// button, after the user has ticked the upload box and seen the preview.
// Returns the paste URL, or throws — every caller must be able to fall back to
// the clipboard, because the host rate-limits aggressively.
async function uploadSnapshot(html) {
  const body = trimToBytes(html, UPLOAD_MAX_BYTES);
  const response = await fetch(SNAPSHOT_ENDPOINT, {
    method: 'POST',
    // A simple content type on purpose: the host answers OPTIONS with 404 and
    // sends no Access-Control-Allow-Origin, so anything that triggers a CORS
    // preflight fails outright. The extension's host_permissions entry is what
    // lets us read the response at all.
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body,
  });
  if (!response.ok) throw new Error(`upload failed (${response.status})`);

  const text = (await response.text()).trim();

  // Never drop raw response text into an issue body — it becomes a markdown
  // link in a public issue. Validate by PARSING rather than by substring: the
  // origin must be exactly the host we posted to, and the path must be a bare
  // paste id. A prefix test would accept anything the host chose to append.
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('unexpected upload response');
  }
  if (`${parsed.origin}/` !== SNAPSHOT_ENDPOINT || !PASTE_PATH.test(parsed.pathname)) {
    throw new Error('unexpected upload response');
  }

  // Extension stripped: `<id>.html` makes paste.rs RENDER the captured page
  // instead of serving it as text. Done with lastIndexOf rather than a
  // `/\.[a-z0-9]+$/` replace: a trailing-quantifier regex run over data that
  // came back from the network is quadratic in the input length, which is a
  // code-scanning finding (js/polynomial-redos) as well as a real, if small,
  // way for the host to waste the popup's main thread.
  const path = parsed.pathname;
  const dot = path.lastIndexOf('.');

  return {
    url: `${parsed.origin}${dot > 0 ? path.slice(0, dot) : path}`,
    // 206 means the host truncated it; a client-side trim means we did.
    partial: response.status === 206 || body !== html,
  };
}

// 'granted' | 'missing' | 'unknown'. Never throws: an older host without the
// permissions API answers 'unknown', and the caller then just tries the upload
// and lets it fail into the clipboard path, which is what shipped before.
async function uploadPermission() {
  if (!api.permissions || !api.permissions.contains) return 'unknown';
  try {
    return await api.permissions.contains({ origins: [SNAPSHOT_ORIGIN] }) ? 'granted' : 'missing';
  } catch {
    return 'unknown';
  }
}

async function requestUploadPermission() {
  if (!api.permissions || !api.permissions.request) return false;
  try {
    return await api.permissions.request({ origins: [SNAPSHOT_ORIGIN] });
  } catch {
    return false;
  }
}

// ── Popup wiring ────────────────────────────────────────────────────────────

async function readBuildInfo() {
  try {
    const response = await fetch(api.runtime.getURL('build-info.json'));
    const info = await response.json();
    // "dev" survives into un-stamped local builds; say so rather than lie.
    return { version: info.version, build: info.build };
  } catch {
    const manifest = api.runtime.getManifest ? api.runtime.getManifest() : {};
    return { version: manifest.version, build: '' };
  }
}

// Never throws: a report with no page details is still worth filing, and an
// exception here would leave the popup with dead buttons and no explanation.
async function readSnapshot() {
  let tab;
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch { /* no tabs access at all */ }
  if (!tab) return { url: '', unreachable: true };

  try {
    const snapshot = await api.tabs.sendMessage(tab.id, { type: COLLECT_MESSAGE });
    if (snapshot && !snapshot.error) return snapshot;
  } catch {
    // No collector on this tab: the extension is not allowed here, or this is
    // not one of the sites it runs on.
  }
  return { url: tab.url || '', title: tab.title || '', unreachable: true };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebKit, or a popup that lost the gesture: fall back to a selection.
    const scratch = document.createElement('textarea');
    scratch.value = text;
    document.body.appendChild(scratch);
    scratch.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    scratch.remove();
    return copied;
  }
}

// The checkboxes are rendered from SYMPTOMS rather than written into
// report.html, so the label a user taps and the line the issue body gets are
// the same string. (An extension page may not inline a <script>, but it may
// build its own DOM.)
function renderSymptoms(container) {
  for (const symptom of SYMPTOMS) {
    const option = document.createElement('label');
    option.className = 'option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = symptom.id;
    const text = document.createElement('span');
    text.textContent = symptom.label;
    option.append(box, text);
    container.append(option);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const titleField = document.getElementById('title');
  const descriptionField = document.getElementById('description');
  const symptomList = document.getElementById('symptoms');
  const includeHtml = document.getElementById('include-html');
  const uploadHtml = document.getElementById('upload-html');
  const uploadBlocked = document.getElementById('upload-blocked');
  const allowUpload = document.getElementById('allow-upload');
  const preview = document.getElementById('preview');
  const status = document.getElementById('status');
  const fileButton = document.getElementById('file');
  const copyButton = document.getElementById('copy');
  const pageLabel = document.getElementById('page');

  renderSymptoms(symptomList);
  const selectedSymptoms = () => {
    const checked = new Set(
      [...symptomList.querySelectorAll('input:checked')].map((box) => box.value),
    );
    return SYMPTOMS.filter((symptom) => checked.has(symptom.id));
  };

  const [buildInfo, snapshot] = await Promise.all([readBuildInfo(), readSnapshot()]);
  const { environment, pageState, diagnostics, samples } = describeSnapshot(snapshot, buildInfo);

  // The title tracks the ticked symptoms until the user types their own.
  let titleEdited = false;
  titleField.value = defaultTitle(snapshot.url);
  titleField.addEventListener('input', () => { titleEdited = true; });

  pageLabel.textContent = snapshot.unreachable
    ? 'No page details — open this from a Reddit or X tab with the extension allowed.'
    : snapshot.url;
  if (snapshot.unreachable) {
    includeHtml.checked = false;
    includeHtml.disabled = true;
  }

  // Nothing to upload if there is no HTML in the report to begin with.
  let permission = await uploadPermission();

  function syncUploadOption() {
    uploadHtml.disabled = !includeHtml.checked || !snapshot.html;
    // Surface the missing grant before the user commits to filing, so the
    // prompt happens on its own button rather than in the middle of the flow.
    const blocked = permission === 'missing' && !uploadHtml.disabled && uploadHtml.checked;
    uploadBlocked.hidden = !blocked;
    allowUpload.hidden = !blocked;
  }
  syncUploadOption();

  allowUpload.addEventListener('click', async () => {
    allowUpload.disabled = true;
    permission = await requestUploadPermission() ? 'granted' : 'missing';
    allowUpload.disabled = false;
    status.textContent = permission === 'granted'
      ? 'paste.rs allowed — the snapshot will be uploaded and linked.'
      : 'Still not allowed. You can file without it: the snapshot goes to your clipboard.';
    syncUploadOption();
  });

  const willUpload = () => includeHtml.checked && uploadHtml.checked && !!snapshot.html;

  function parts(extra) {
    return {
      symptoms: selectedSymptoms(),
      description: descriptionField.value,
      environment,
      pageState: snapshot.unreachable ? '' : pageState,
      diagnostics: snapshot.unreachable ? '' : diagnostics,
      samples: snapshot.unreachable ? '' : samples,
      html: includeHtml.checked ? snapshot.html : '',
      htmlNote: '<sub>Scripts, styles, meta values, credential-shaped attributes and typed-in values were stripped before capture.</sub>',
      ...extra,
    };
  }

  // The captured HTML runs to six figures, so only push it into the <pre> when
  // the disclosure is actually open — otherwise every keystroke would rewrite
  // a 100 KB text node nobody is looking at.
  const disclosure = document.querySelector('details');

  // What the preview shows and the Copy button copies is what the user will
  // paste, GitHub's issue-body limit already applied — not a longer report
  // that gets rejected on submit with "Body can not be longer than 65536
  // characters", which is what shipping the untrimmed copy actually did.
  function refresh() {
    // When the snapshot is going to be uploaded it is not part of the body at
    // all, so the preview shows the pending-upload line in its place. The
    // preview is the consent step, and it has to say what will be sent — now
    // something leaves the device before GitHub even opens.
    const upload = willUpload();
    const fitted = fitClipboard(
      parts(upload ? { html: '', htmlPending: true } : {}), BODY_BUDGET,
    );
    if (disclosure.open) preview.textContent = fitted.body;
    const size = `${fitted.body.length.toLocaleString()} characters`;
    status.textContent = fitted.truncated && !upload
      ? `${size} — trimmed to fit a GitHub issue`
      : size;
    return fitted.body;
  }

  // The body now carries up to 400 KB of page HTML, so rebuilding it on every
  // keystroke is real work on a phone. Typing is the only high-frequency
  // input; everything else refreshes immediately.
  let pending;
  descriptionField.addEventListener('input', () => {
    clearTimeout(pending);
    pending = setTimeout(refresh, 150);
  });
  includeHtml.addEventListener('change', () => { syncUploadOption(); refresh(); });
  uploadHtml.addEventListener('change', refresh);
  disclosure.addEventListener('toggle', refresh);
  symptomList.addEventListener('change', () => {
    if (!titleEdited) titleField.value = defaultTitle(snapshot.url, selectedSymptoms());
    refresh();
  });
  refresh();

  copyButton.addEventListener('click', async () => {
    const copied = await copyText(refresh());
    status.textContent = copied ? 'Full report copied.' : 'Could not copy — select the preview text instead.';
  });

  fileButton.addEventListener('click', async () => {
    refresh();
    const chosen = selectedSymptoms();
    const title = titleField.value.trim() || defaultTitle(snapshot.url, chosen);

    // Upload first, so the issue can carry a link to the whole snapshot
    // instead of the fragment a URL or a clipboard paste can hold. The host
    // rate-limits hard and can simply be down, so a failure here is expected
    // and must not cost the report: fall back to the previous behaviour.
    let uploaded = null;
    let outcome = '';
    if (willUpload()) {
      fileButton.disabled = true;

      // Ask before uploading rather than letting the fetch raise the prompt:
      // that prompt dismisses the popup, and this whole handler with it.
      if (permission === 'missing') {
        status.textContent = 'Asking Safari to allow paste.rs…';
        permission = await requestUploadPermission() ? 'granted' : 'missing';
        syncUploadOption();
      }

      if (permission === 'missing') {
        outcome = 'not allowed by Safari for paste.rs, so the snapshot is on the reporter’s clipboard';
        status.textContent = 'paste.rs not allowed — the report is going to your clipboard.';
      } else {
        status.textContent = 'Uploading the page snapshot…';
        try {
          uploaded = await uploadSnapshot(snapshot.html);
        } catch {
          outcome = 'attempted but failed (host unreachable, rate limited, or blocked)';
          status.textContent = 'Upload failed — putting the report on your clipboard instead.';
        }
      }
      fileButton.disabled = false;
    } else if (includeHtml.checked && snapshot.html) {
      outcome = 'declined by the reporter';
    }

    const reportParts = parts(uploaded
      ? { html: '', htmlLink: uploaded.url, htmlPartial: uploaded.partial }
      : { uploadOutcome: outcome });
    const fitted = fitIssue(title, reportParts, URL_BUDGET);

    // What the clipboard gets, if it is needed. Built from reportParts rather
    // than from the preview: the preview was showing the pending-upload line,
    // which carries no snapshot at all — copying that after a failed upload
    // would hand the user a report with the one thing they came for missing.
    const clipboardCopy = () => fitClipboard(reportParts, BODY_BUDGET).body;

    // With a link the body is complete on its own. Without one, only what fits
    // survives the URL and the page HTML never does, so the clipboard carries
    // it — the note in the issue body tells the user to paste.
    if (!uploaded && fitted.truncated) await copyText(clipboardCopy());

    try {
      await api.tabs.create({ url: fitted.url });
    } catch {
      await copyText(clipboardCopy());
      status.textContent = 'Could not open GitHub — the report is on your clipboard.';
      return;
    }
    if (uploaded) {
      status.textContent = 'Opened GitHub with the snapshot linked. Review it, then press Submit.';
    } else if (fitted.truncated) {
      status.textContent = 'Opened GitHub. The full report is on your clipboard — paste it in.';
    } else {
      status.textContent = 'Opened GitHub. Review it, then press Submit.';
    }
    try { window.close(); } catch { /* the host closes the popup itself */ }
  });
});
