// cdp.mjs — a minimal Chrome DevTools Protocol client, no dependencies.
//
// This repo ships no package.json on purpose: the product is two vanilla-JS
// content scripts and `node --test` runs with nothing installed. The scroll
// harness needs a real browser anyway, so rather than pull in Playwright it
// speaks CDP directly — Node 22 has a global WebSocket, and Chrome exposes the
// protocol on --remote-debugging-port. About 120 lines buys a dependency-free
// `node test/scroll/run.mjs` that works wherever a Chrome/Chromium binary
// exists, including a bare CI runner.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ordered by how likely it is to be the one you meant: an explicit override,
// then the CI runners' Chrome, then the usual Linux/macOS install paths, then
// the browser a Playwright install would have dropped in this environment.
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
];

export function findChrome() {
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  // A Playwright-style install directory whose build number we cannot guess.
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const dir of ['chromium', 'chromium-1194']) {
      const guess = join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(guess)) return guess;
    }
  }
  return null;
}

async function fetchJson(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* the browser is not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`browser never answered ${url}`);
}

export async function launch({ headless = true, width = 440, height = 796 } = {}) {
  const binary = findChrome();
  if (!binary) throw new Error('no Chrome/Chromium binary found (set CHROME_PATH)');

  const profile = await mkdtemp(join(tmpdir(), 'keep-scrolling-cdp-'));
  const child = spawn(binary, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...(headless ? ['--headless=new'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-gpu',
    '--no-sandbox',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // Chrome prints the DevTools endpoint on stderr; the port is ephemeral
  // (--remote-debugging-port=0) so it has to be read back rather than assumed.
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('browser did not report a DevTools port')), 30000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited (${code})`)); });
  });

  const close = async () => {
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  return { endpoint, browserUrl: endpoint.replace(/^ws:\/\/([^/]+).*/, 'http://$1'), close };
}

// One WebSocket, one page target. Commands are awaited by id; events are
// dispatched to any listeners registered for their method.
export class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
        else resolve(message.result);
        return;
      }
      for (const fn of this.listeners.get(message.method) || []) fn(message.params);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.ws.close(); }
}

export async function newPage(browser) {
  const { webSocketDebuggerUrl } = await fetchJson(`${browser.browserUrl}/json/new`, 1)
    .catch(() => fetchJson(`${browser.browserUrl}/json/list`).then((list) => list.find((t) => t.type === 'page')));
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not attach to the page target')), { once: true });
  });
  return new Session(ws);
}
