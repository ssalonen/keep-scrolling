// report.js
// Popup logic for the "Report a problem" sheet (report.html).
//
// It asks the collector content script for a snapshot of the current page,
// formats it together with the symptoms the user ticked, whatever they typed
// and the shipped build version, and hands the result to GitHub as a PREFILLED
// new-issue URL.
//
// Design notes:
//  - Nothing is ever uploaded from here. There is no API token, no POST, no
//    third-party endpoint: the last step is opening github.com's own
//    /issues/new page with title+body in the query string, which the user then
//    reads and submits themselves. That keeps the app's "nothing leaves your
//    device" promise honest — the user is the transport.
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
    symptoms, description, environment, pageState, diagnostics, samples, html, htmlNote, htmlOmitted,
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

  if (html) {
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

  function parts() {
    return {
      symptoms: selectedSymptoms(),
      description: descriptionField.value,
      environment,
      pageState: snapshot.unreachable ? '' : pageState,
      diagnostics: snapshot.unreachable ? '' : diagnostics,
      samples: snapshot.unreachable ? '' : samples,
      html: includeHtml.checked ? snapshot.html : '',
      htmlNote: '<sub>Scripts, styles, meta values, credential-shaped attributes and typed-in values were stripped before capture.</sub>',
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
    const fitted = fitClipboard(parts(), BODY_BUDGET);
    if (disclosure.open) preview.textContent = fitted.body;
    const size = `${fitted.body.length.toLocaleString()} characters`;
    status.textContent = fitted.truncated ? `${size} — trimmed to fit a GitHub issue` : size;
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
  includeHtml.addEventListener('change', refresh);
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
    const full = refresh();
    const chosen = selectedSymptoms();
    const title = titleField.value.trim() || defaultTitle(snapshot.url, chosen);
    const fitted = fitIssue(title, parts(), URL_BUDGET);

    // Only what fits survives the URL, and the page HTML essentially never
    // does. Put the whole report on the clipboard so the user can paste it in
    // — the note in the issue body tells them to.
    if (fitted.truncated) await copyText(full);

    try {
      await api.tabs.create({ url: fitted.url });
    } catch {
      await copyText(full);
      status.textContent = 'Could not open GitHub — the report is on your clipboard.';
      return;
    }
    status.textContent = fitted.truncated
      ? 'Opened GitHub. The full report is on your clipboard — paste it in.'
      : 'Opened GitHub. Review it, then press Submit.';
    try { window.close(); } catch { /* the host closes the popup itself */ }
  });
});
