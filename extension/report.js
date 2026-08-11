// report.js
// Popup logic for the "Report a problem" sheet (report.html).
//
// It asks the collector content script for a snapshot of the current page,
// formats it together with whatever the user typed and the shipped build
// version, and hands the result to GitHub as a PREFILLED new-issue URL.
//
// Design notes:
//  - Nothing is ever uploaded from here. There is no API token, no POST, no
//    third-party endpoint: the last step is opening github.com's own
//    /issues/new page with title+body in the query string, which the user then
//    reads and submits themselves. That keeps the app's "nothing leaves your
//    device" promise honest — the user is the transport.
//  - GitHub answers an over-long request line with 414, so the prefilled URL is
//    budgeted (URL_BUDGET) and the page-HTML block is shrunk until it fits.
//    The untruncated report stays available via the Copy button, for pasting
//    into the issue after it opens.
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
  const { description, environment, pageState, html, htmlNote } = parts;
  const sections = [
    (description || '').trim() || '_No description provided._',
    '',
    '### Environment',
    '',
    formatEnvironment(environment || {}),
  ];

  if (pageState) {
    sections.push('', '### Page state', '', fence('json', pageState));
  }

  if (html) {
    sections.push(
      '',
      '<details><summary>Page HTML (sanitized, truncated)</summary>',
      '',
      fence('html', html),
      '',
      '</details>',
    );
    if (htmlNote) sections.push('', htmlNote);
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

// Shrink the report until the prefilled URL fits GitHub's request-line limit.
// The page HTML is the only unbounded part, so it is cut first and the user's
// own words survive; only if the text alone still overflows does the whole body
// get clipped. Returns the fitted body, its URL, and whether anything was lost
// (the caller offers the full text on the clipboard when it was).
function fitIssue(title, parts, budget) {
  const fullHtml = parts.html || '';
  let html = fullHtml;
  let body = buildBody({ ...parts, html });
  let url = issueUrl(title, body);
  let truncated = false;

  // Each dropped character is worth up to three URL-encoded ones, so divide the
  // overshoot by three (plus slack for the truncation marker) to guarantee the
  // loop shrinks and terminates rather than nibbling one char at a time.
  while (url.length > budget && html.length > 0) {
    const excess = url.length - budget;
    const keep = Math.max(0, html.length - Math.ceil(excess / 3) - 64);
    html = keep > 0 ? truncate(html, keep) : '';
    body = buildBody({ ...parts, html });
    url = issueUrl(title, body);
    truncated = true;
  }

  // Still over budget with no HTML left: the typed description itself is huge.
  // Clip the whole body — a filed-but-shortened issue beats a 414.
  while (url.length > budget) {
    const excess = url.length - budget;
    const keep = body.length - Math.ceil(excess / 3) - 64;
    body = truncate(body, Math.max(200, keep));
    url = issueUrl(title, body);
    truncated = true;
    if (keep < 200) break;
  }

  return { body, url, truncated };
}

function defaultTitle(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  return host ? `Nag not removed on ${host}` : 'Bug report';
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

  const pageState = snapshot.lock || snapshot.signatures
    ? JSON.stringify({ lock: snapshot.lock, signatures: snapshot.signatures }, null, 2)
    : '';

  return { environment, pageState };
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

document.addEventListener('DOMContentLoaded', async () => {
  const titleField = document.getElementById('title');
  const descriptionField = document.getElementById('description');
  const includeHtml = document.getElementById('include-html');
  const preview = document.getElementById('preview');
  const status = document.getElementById('status');
  const fileButton = document.getElementById('file');
  const copyButton = document.getElementById('copy');
  const pageLabel = document.getElementById('page');

  const [buildInfo, snapshot] = await Promise.all([readBuildInfo(), readSnapshot()]);
  const { environment, pageState } = describeSnapshot(snapshot, buildInfo);

  titleField.value = defaultTitle(snapshot.url);
  pageLabel.textContent = snapshot.unreachable
    ? 'No page details — open this from a Reddit or X tab with the extension allowed.'
    : snapshot.url;
  if (snapshot.unreachable) {
    includeHtml.checked = false;
    includeHtml.disabled = true;
  }

  function parts() {
    return {
      description: descriptionField.value,
      environment,
      pageState: snapshot.unreachable ? '' : pageState,
      html: includeHtml.checked ? snapshot.html : '',
      htmlNote: '<sub>Scripts, styles, credential-shaped attributes and typed-in values were stripped before capture.</sub>',
    };
  }

  // The captured HTML runs to six figures, so only push it into the <pre> when
  // the disclosure is actually open — otherwise every keystroke would rewrite
  // a 100 KB text node nobody is looking at.
  const disclosure = document.querySelector('details');

  function refresh() {
    const body = buildBody(parts());
    if (disclosure.open) preview.textContent = body;
    status.textContent = `${body.length.toLocaleString()} characters`;
    return body;
  }

  descriptionField.addEventListener('input', refresh);
  includeHtml.addEventListener('change', refresh);
  disclosure.addEventListener('toggle', refresh);
  refresh();

  copyButton.addEventListener('click', async () => {
    const copied = await copyText(refresh());
    status.textContent = copied ? 'Full report copied.' : 'Could not copy — select the preview text instead.';
  });

  fileButton.addEventListener('click', async () => {
    const full = refresh();
    const title = titleField.value.trim() || defaultTitle(snapshot.url);
    const fitted = fitIssue(title, parts(), URL_BUDGET);

    // Only what fits survives the URL. When that cost us page HTML, put the
    // whole thing on the clipboard so the user can paste it into the issue.
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
