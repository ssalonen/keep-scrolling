// mirror.mjs — take a live page offline, JavaScript and all.
//
// The harness's plain URL mode loads a page with every request blocked, so the
// site's own client code never runs. That is enough to test a server-rendered
// cover, and not enough for anything a site does on mount: X applies its scroll
// lock from a React effect, and a prompt that only exists after hydration
// cannot be reproduced by a page that never hydrates.
//
// So: fetch the page and everything it transitively imports with Node's fetch
// (which honours a corporate/agent HTTPS_PROXY, where a browser often will
// not), rewrite the asset host to a same-origin path, and serve the tree from
// localhost. The browser then needs no internet at all and the site's real
// bundle executes.
//
// What this does NOT reproduce: anything that needs the site's API. X's
// conversation query fails, so the reply list stays as the placeholders the
// server rendered. That is a faithful copy of the *document*, not of a logged-
// in session — say so when reporting a result from it.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

// Bundlers emit sibling imports relatively ("./chunk-hash.js"); the HTML and
// stylesheets reference the CDN absolutely. Follow both, or the module graph
// arrives with holes and nothing executes.
const RELATIVE = /["'(](\.\/[A-Za-z0-9._-]+\.(?:js|css))["')]/g;
const ABSOLUTE = /https:\/\/[a-z0-9.-]*\.(?:twimg|redditstatic|redditmedia)\.com\/[A-Za-z0-9._/-]+\.(?:js|css|woff2?)/g;
// The asset hosts the two supported sites serve their bundles from. Mirroring
// follows links found inside fetched documents, so this is the fence.
const ASSET_HOSTS = [
  'abs.twimg.com', 'pbs.twimg.com', 'video.twimg.com',
  'www.redditstatic.com', 'styles.redditmedia.com',
];

// Every path below is built from a URL that came out of a page we do not
// control, so none of it may be trusted to stay inside the output directory:
// `/a/../../etc/x` is a perfectly ordinary-looking pathname. Resolve, then
// require real containment — `startsWith(root)` alone also accepts `/tmp/mirror-evil`
// for a root of `/tmp/mirror`, which is why the separator is part of the test.
function within(root, ...parts) {
  const base = resolve(root);
  const full = resolve(base, ...parts);
  return full === base || full.startsWith(base + sep) ? full : null;
}

// Only http(s), and only hosts the page itself is built from. This is a
// developer tool pointed at a page by hand, but it then follows URLs found
// *inside* that page, and "follow whatever the document says" is how a mirror
// turns into a request-forgery gadget aimed at localhost or a metadata service.
function fetchable(url, allowedHosts) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return allowedHosts.has(u.host) ? u : null;
}

export async function mirror(pageUrl, outDir, { log = () => {} } = {}) {
  const seen = new Set();
  let bytes = 0;
  let failed = 0;
  // The page's own host, plus the asset CDNs the ABSOLUTE pattern already
  // limits us to. Filled in once the page URL is parsed.
  const allowedHosts = new Set();

  async function grab(url) {
    if (seen.has(url)) return null;
    seen.add(url);
    const u = fetchable(url, allowedHosts);
    if (!u) { failed += 1; return null; }
    const file = within(outDir, u.host, `.${u.pathname}`);
    if (!file) { failed += 1; return null; }
    try {
      const res = await fetch(u, { headers: { 'User-Agent': IPHONE_UA }, redirect: 'follow' });
      if (!res.ok) { failed += 1; return null; }
      const body = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      bytes += body.length;
      return body.toString('utf8');
    } catch { failed += 1; return null; }
  }

  async function walk(url, depth) {
    const text = await grab(url);
    if (text === null || depth > 8) return;
    const base = new URL(url);
    const refs = new Set();
    for (const m of text.matchAll(RELATIVE)) refs.add(new URL(m[1], base).href);
    for (const m of text.matchAll(ABSOLUTE)) refs.add(m[0]);
    for (const ref of refs) await walk(ref, depth + 1);
  }

  const page = fetchable(pageUrl, new Set([new URL(pageUrl).host]));
  if (!page) throw new Error(`not an http(s) URL: ${pageUrl}`);
  allowedHosts.add(page.host);
  for (const host of ASSET_HOSTS) allowedHosts.add(host);

  const html = await grab(page.href);
  if (html === null) throw new Error(`could not fetch ${pageUrl}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'index.html'),
    html.replace(/https:\/\/([a-z0-9.-]*\.(?:twimg|redditstatic|redditmedia)\.com)\//g, '/$1/'),
  );

  for (const root of [...new Set(html.match(ABSOLUTE) || [])]) await walk(root, 0);
  log(`mirrored ${seen.size} files, ${(bytes / 1e6).toFixed(1)} MB${failed ? `, ${failed} failed` : ''}`);
  return join(outDir, 'index.html');
}

/** Serve a mirrored tree on localhost. Returns { origin, close }. */
export async function serve(dir) {
  const server = createServer((req, res) => {
    let path;
    try { path = decodeURIComponent((req.url || '/').split('?')[0]); } catch { path = ''; }
    const file = path && within(dir, `.${path === '/' ? '/index.html' : path}`);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end('not mirrored'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// Only when run as a command. `node --test` imports every file under test/ and
// sets process.argv[1] to it, so a bare direct-invocation check fires there too.
const RUN_DIRECTLY = !process.env.NODE_TEST_CONTEXT
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  const [url, dir] = process.argv.slice(2);
  if (!url || !dir) {
    console.error('usage: node test/scroll/mirror.mjs <url> <output-dir>');
    process.exit(2);
  }
  await mirror(url, dir, { log: console.log });
}
