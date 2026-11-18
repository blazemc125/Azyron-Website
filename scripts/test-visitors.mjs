/**
 * End-to-end test for the browser visitor client (docs/assets/js/visitors.js).
 *
 * The real Express app runs on a local port; jsdom loads the client against it
 * and we assert the things the user actually asked for:
 *   - the homepage shows TOTAL UNIQUE VISITORS and LIVE ACTIVE VISITORS
 *   - a first open shows 1 unique
 *   - reloading / ten tabs does not raise the unique total
 *   - the number refreshes every ~1 second without a reload
 *   - active decays to 0 once the 30s window passes (clock advanced)
 *   - a backend that is not there produces an honest message, never a number
 *
 * Run: node --test scripts/test-visitors.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = mkdtempSync(join(tmpdir(), 'azyron-visitors-e2e-'));
process.env.ANALYTICS_FILE = join(tmp, 'downloads.log');
process.env.VISITORS_FILE = join(tmp, 'visitors.log');
process.env.ALLOWED_ORIGINS = 'https://blazemc125.github.io';
process.env.CACHE_TTL_MS = '100';

let server;
let baseUrl;
let store;
/** Every jsdom window ever opened, so `after` can shut them all down. */
const openDoms = new Set();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot the real app once for the whole file. */
before(async () => {
  const { createApp } = await import('../azyron-website/server.js');
  store = await import('../azyron-website/lib/visitors.js');
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const dom of openDoms) close(dom);
  openDoms.clear();
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
  // jsdom timers and the listening socket can outlive the run; the test file
  // must not hang waiting on them.
  setTimeout(() => process.exit(0), 100).unref();
});

/**
 * Build a jsdom page that loads the real client file against the live API.
 * `storage` seeds localStorage so a "reload" keeps the same visitor id.
 */
async function openPage({ api = baseUrl, storage = {} } = {}) {
  const html = `<!doctype html><html><body>
    <div class="visitors" id="visitors" data-state="connecting">
      <span class="visitors__k">TOTAL UNIQUE VISITORS</span>
      <span class="visitors__v" id="visitorUnique">—</span>
      <span class="visitors__sub" id="visitorUniqueSub"></span>
      <span class="visitors__k"><span class="live__dot"></span>LIVE ACTIVE VISITORS</span>
      <span class="visitors__v" id="visitorActive">—</span>
      <span class="visitors__sub" id="visitorActiveSub"></span>
      <span class="visitors__status" id="visitorStatus" data-state="connecting">
        <span class="visitors__status-dot"></span><span id="visitorStatusText">CONNECTING</span>
      </span>
      <span class="visitors__note" id="visitorNote"></span>
      <button id="visitorRetry" hidden>RETRY</button>
    </div>
  </body></html>`;

  const dom = new JSDOM(html, { url: `${baseUrl}/?api=${encodeURIComponent(api)}`, runScripts: 'outside-only' });
  const { window } = dom;

  // jsdom has no BroadcastChannel; the client must work without it.
  if (!window.BroadcastChannel) delete window.BroadcastChannel;

  // jsdom ships no fetch/AbortController of its own. Bridge to Node's so the
  // client talks to the real Express app over real HTTP.
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return fetch(url, init);
  };
  window.AbortController = AbortController;

  // Persist a chosen visitor id into this window's localStorage.
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);

  const source = await (await import('node:fs/promises')).readFile(
    new URL('../docs/assets/js/visitors.js', import.meta.url),
    'utf8',
  );
  window.eval(`(async () => { ${source.replace(/^export .*$/gm, '')} })()`);

  return dom;
}

const text = (dom, id) => dom.window.document.getElementById(id)?.textContent?.trim();
const status = (dom) => dom.window.document.getElementById('visitorStatus')?.dataset.state;

/** Wait until a predicate holds, or fail with the last rendered state. */
async function until(fn, label, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false; // a closing jsdom window must not fail the wait
    }
    if (ok) return;
    if (Date.now() - started > timeout) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await wait(50);
  }
}

/** jsdom has no close(); tear the window down so timers stop. */
function close(dom) {
  openDoms.delete(dom);
  try {
    dom.window.close();
  } catch {
    /* already gone */
  }
}

test('the homepage labels unique and active as two separate numbers', async () => {
  const dom = await openPage();
  await until(() => status(dom) === 'live', 'live status');
  const doc = dom.window.document;
  const labels = [...doc.querySelectorAll('.visitors__k')].map((n) =>
    n.textContent.replace(/\s+/g, ' ').replace(/^LIVE /, (m) => m).trim(),
  );
  assert.ok(labels.includes('TOTAL UNIQUE VISITORS'));
  assert.ok(labels.some((l) => l.includes('LIVE ACTIVE VISITORS')));
  // Two numbers, two elements, neither left blank or dashed while live.
  assert.match(text(dom, 'visitorUnique'), /^\d+$/);
  assert.match(text(dom, 'visitorActive'), /^\d+$/);
  close(dom);
});

test('a first-time visitor sees 1 unique and 1 active', async () => {
  store.resetForTests();
  rmSync(process.env.VISITORS_FILE, { force: true });
  store.resetForTests();

  const dom = await openPage();
  await until(() => status(dom) === 'live', 'live status');
  await until(() => text(dom, 'visitorUnique') === '1', 'unique=1');
  assert.equal(text(dom, 'visitorActive'), '1');
  assert.match(text(dom, 'visitorUniqueSub'), /player/i);
  close(dom);
});

test('reloading the page does not raise the unique total', async () => {
  const first = await openPage();
  await until(() => status(first) === 'live', 'first live');
  const id = first.window.localStorage.getItem('azyron:vid');
  close(first);

  for (let i = 0; i < 3; i += 1) {
    const again = await openPage({ storage: { 'azyron:vid': id } });
    await until(() => status(again) === 'live', 'reload live');
    await until(() => text(again, 'visitorUnique') === '1', 'still 1 unique');
    close(again);
  }
});

test('ten tabs of the same visitor keep unique at 1', async () => {
  const first = await openPage();
  await until(() => status(first) === 'live', 'first live');
  const id = first.window.localStorage.getItem('azyron:vid');

  const tabs = await Promise.all(
    Array.from({ length: 10 }, () => openPage({ storage: { 'azyron:vid': id } })),
  );
  await Promise.all(tabs.map((t) => until(() => status(t) === 'live', 'tab live')));
  for (const tab of tabs) {
    assert.equal(text(tab, 'visitorUnique'), '1');
    close(tab);
  }
  const totals = await (await fetch(`${baseUrl}/api/visits`)).json();
  assert.equal(totals.unique, 1);
});

test('a second visitor raises the shared total for everyone', async () => {
  const a = await openPage();
  await until(() => status(a) === 'live', 'a live');

  const other = await openPage({ storage: { 'azyron:vid': 'f'.repeat(32) } });
  await until(() => status(other) === 'live', 'other live');

  // The first tab is polling once a second, so it must pick this up on its own.
  await until(() => text(a, 'visitorUnique') === '2', 'tab A sees 2');
  assert.equal(text(a, 'visitorActive'), '2');
  close(a);
  close(other);
});

test('the displayed total updates on its own within ~1.5s (no refresh)', async () => {
  const viewer = await openPage();
  await until(() => status(viewer) === 'live', 'viewer live');
  const before = text(viewer, 'visitorUnique');

  // A new player arrives out of band.
  const res = await fetch(`${baseUrl}/api/visits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: 'e'.repeat(32) }),
  });
  const { unique } = await res.json();

  const t0 = Date.now();
  await until(() => text(viewer, 'visitorUnique') === String(unique), 'automatic update', 4000);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `updated in ${elapsed}ms, expected under 1500ms`);
  assert.notEqual(before, String(unique));
  close(viewer);
});

test('active visitors expire after the 30s window while unique stays put', async () => {
  const before = await (await fetch(`${baseUrl}/api/visits`)).json();
  assert.ok(before.unique >= 1);

  // Ask the store what it will report 31 seconds from now. Active is derived
  // from the last heartbeat, so no delete job is involved.
  const future = store.visitorTotals(Date.now() + 31_000);
  assert.equal(future.active, 0, 'nobody is active 31s later');
  assert.equal(future.unique, before.unique, 'unique is lifetime and must not decay');
});

test('an unreachable backend shows an honest state, never a fabricated number', async () => {
  const dom = await openPage({ api: 'http://127.0.0.1:9' });
  await until(() => ['offline', 'unavailable'].includes(status(dom)), 'offline state', 10_000);
  assert.equal(text(dom, 'visitorUnique'), '—', 'no invented unique total');
  assert.equal(text(dom, 'visitorActive'), '—', 'no invented active count');
  assert.match(text(dom, 'visitorStatusText'), /RECONNECTING|UNAVAILABLE/);
  assert.equal(dom.window.document.getElementById('visitorRetry').hidden, false, 'retry is offered');
  close(dom);
});

test('with no backend configured the panel says so instead of guessing a host', async () => {
  const { JSDOM: JSDOM2 } = await import('jsdom');
  const dom = new JSDOM(
    `<div id="visitors" data-state="connecting">
       <span class="visitors__v" id="visitorUnique">—</span>
       <span class="visitors__v" id="visitorActive">—</span>
       <span class="visitors__sub" id="visitorUniqueSub"></span>
       <span class="visitors__sub" id="visitorActiveSub"></span>
       <span class="visitors__status" id="visitorStatus" data-state="connecting">
         <span id="visitorStatusText">CONNECTING</span>
       </span>
       <span id="visitorNote"></span><button id="visitorRetry" hidden></button>
     </div>`,
    { url: 'https://blazemc125.github.io/Azyron-Website/', runScripts: 'outside-only' },
  );
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../docs/assets/js/visitors.js', import.meta.url),
    'utf8',
  );
  dom.window.eval(`(async () => { ${source.replace(/^export .*$/gm, '')} })()`);
  await wait(60);
  const doc = dom.window.document;
  assert.equal(doc.getElementById('visitorStatus').dataset.state, 'unavailable');
  assert.match(doc.getElementById('visitorStatusText').textContent, /UNAVAILABLE/);
  assert.match(doc.getElementById('visitorNote').textContent, /not deployed/);
  assert.equal(doc.getElementById('visitorUnique').textContent, '—');
  // Retry would only re-fail when nothing is configured, so it is hidden.
  assert.equal(doc.getElementById('visitorRetry').hidden, true);
  close(dom);
});
