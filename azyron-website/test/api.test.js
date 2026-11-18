/**
 * Integration tests for the AZYRON CLIENT site backend.
 *
 * A fake GitHub upstream (API + asset CDN) is started locally and the app is
 * booted with GH_API_BASE pointing at it, so we can prove behaviour that is
 * hard to prove against the real API:
 *   - metadata normalisation (sizes, kinds, totals)
 *   - single-flight server cache (many browser polls => 1 upstream request)
 *   - binary streaming with correct headers (never HTML)
 *   - the asset-url fallback when the CDN cannot be reached
 *   - honest error reporting when GitHub is down
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JAR_BYTES = Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.alloc(64 * 1024, 0x41)]);
const MRPACK_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

let upstream;
let upstreamUrl;
let app;
let server;
let baseUrl;
let upstreamCalls = { release: 0, assets: 0, history: 0 };
let upstreamMode = 'ok';
const tmp = mkdtempSync(join(tmpdir(), 'azyron-test-'));

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      if (req.url.startsWith('/repos/') && req.url.includes('/releases/tags/')) {
        upstreamCalls.release += 1;
        if (upstreamMode === 'down') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"message":"unavailable"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' });
        res.end(JSON.stringify(releasePayload()));
        return;
      }
      if (req.url.startsWith('/repos/') && req.url.includes('/releases?')) {
        upstreamCalls.history += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([releasePayload()]));
        return;
      }
      if (req.url.startsWith('/asset/')) {
        upstreamCalls.assets += 1;
        if (upstreamMode === 'down') {
          res.writeHead(500, { 'content-type': 'text/html' });
          res.end('<html>error</html>');
          return;
        }
        if (upstreamMode === 'html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html>nope</html>');
          return;
        }
        const body = req.url.endsWith('.jar') ? JAR_BYTES : MRPACK_BYTES;
        const range = req.headers.range;
        if (range) {
          const [start, end] = range.replace('bytes=', '').split('-');
          const slice = body.subarray(Number(start), end ? Number(end) + 1 : undefined);
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
          });
          res.end(slice);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
        res.end(body);
        return;
      }
      res.writeHead(404).end('{}');
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
      resolve();
    });
  });
}

function releasePayload() {
  return {
    tag_name: 'azyronclient-v1.0.0',
    name: 'AZYRON CLIENT v1.0.0',
    body: 'AZYRON CLIENT — PERFORMANCE. SMOOTHNESS. STYLE.',
    published_at: '2026-11-17T05:54:56Z',
    updated_at: '2026-11-17T06:05:20Z',
    prerelease: false,
    draft: false,
    html_url: 'https://github.com/blazemc125/AzyronClient/releases/tag/azyronclient-v1.0.0',
    assets: [
      {
        id: 757856664,
        name: 'azyron-client-1.0.0.mrpack',
        size: MRPACK_BYTES.length,
        download_count: 7,
        content_type: 'application/x-modrinth-modpack+zip',
        browser_download_url: `${upstreamUrl}/asset/azyron-client-1.0.0.mrpack`,
      },
      {
        id: 757856668,
        name: 'azyronclient-1.0.0.jar',
        size: JAR_BYTES.length,
        download_count: 3,
        content_type: 'application/java-archive',
        browser_download_url: `${upstreamUrl}/asset/azyronclient-1.0.0.jar`,
      },
    ],
  };
}

before(async () => {
  await startUpstream();
  process.env.GH_API_BASE = upstreamUrl;
  process.env.CACHE_TTL_MS = '5000';
  process.env.ANALYTICS_FILE = join(tmp, 'downloads.log');
  process.env.VISITORS_FILE = join(tmp, 'visitors.log');
  process.env.ALLOWED_ORIGINS = 'https://blazemc125.github.io';
  process.env.FALLBACK_FILE = join(tmp, 'missing-snapshot.json');

  const mod = await import('../server.js?test=1');
  app = mod.createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  upstream?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('release endpoint normalises GitHub metadata', async () => {
  const res = await fetch(`${baseUrl}/api/release`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.version, '1.0.0');
  assert.equal(body.assets.length, 2);

  const jar = body.assets.find((a) => a.kind === 'jar');
  const mrpack = body.assets.find((a) => a.kind === 'mrpack');
  assert.ok(jar && mrpack, 'both asset kinds detected');
  assert.equal(jar.size, JAR_BYTES.length);
  assert.equal(jar.sizeLabel, '64.0 KB');
  assert.equal(jar.downloads, 3);
  assert.equal(body.totals.downloads, 10);
  assert.equal(body.totals.files, 2);

  // The public payload must expose a same-origin download route, never a raw
  // HTML page or a release-page redirect.
  assert.match(jar.downloadUrl, /^\/api\/download\/757856668/);
  assert.ok(!body.assets.some((a) => a.downloadUrl.includes('releases/tag')));
});

test('server cache collapses concurrent polls into one upstream request', async () => {
  const before = upstreamCalls.release;
  const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${baseUrl}/api/release`)));
  await Promise.all(responses.map((r) => r.json()));
  assert.equal(upstreamCalls.release - before, 0, 'served entirely from cache');
});

test('download streams the real binary with attachment headers', async () => {
  const res = await fetch(`${baseUrl}/api/download/757856668`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/java-archive');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="azyronclient-1\.0\.0\.jar"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, JAR_BYTES.length);
  assert.equal(createHash('sha256').update(buf).digest('hex'), createHash('sha256').update(JAR_BYTES).digest('hex'));
  assert.ok(!buf.subarray(0, 64).toString('utf8').includes('<html'), 'binary, not an HTML page');
});

test('download supports range requests', async () => {
  const res = await fetch(`${baseUrl}/api/download/757856664`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(res.status, 206);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 4);
  assert.equal(buf.toString('hex'), MRPACK_BYTES.subarray(0, 4).toString('hex'));
});

test('proxied downloads are counted (real, never invented)', async () => {
  // Range/resume requests deliberately do NOT count as extra downloads.
  const before = (await (await fetch(`${baseUrl}/api/stats`)).json()).totals.proxied;
  const full = await fetch(`${baseUrl}/api/download/757856668`);
  await full.arrayBuffer();
  await fetch(`${baseUrl}/api/download/757856664`, { headers: { Range: 'bytes=0-1' } }).then((r) => r.arrayBuffer());

  const body = await (await fetch(`${baseUrl}/api/stats`)).json();
  assert.equal(body.totals.proxied, before + 1, 'exactly one new download recorded despite the range request');
  assert.equal(body.byAssetId['757856668'], 2);
  assert.equal(body.byAssetId['757856664'] ?? 0, 0, 'partial range fetch is not a download');
});

test('HTML upstream responses fall back to the official asset URL', async () => {
  upstreamMode = 'html';
  const res = await fetch(`${baseUrl}/api/download/757856668`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/asset\/azyronclient-1\.0\.0\.jar$/);
  upstreamMode = 'ok';
});

test('unknown asset id returns a real 404', async () => {
  const res = await fetch(`${baseUrl}/api/download/999999`);
  assert.equal(res.status, 404);
});

test('changelog endpoint lists releases', async () => {
  const res = await fetch(`${baseUrl}/api/releases`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.releases[0].tag, 'azyronclient-v1.0.0');
  assert.equal(body.releases[0].assets.length, 2);
});

test('serves the static site (docs/) and its 404 page', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /AZYRON/i);
  // the same files GitHub Pages publishes: relative asset URLs only
  assert.match(html, /href="\.\/assets\/css\/styles\.css"/);
  assert.ok(!/href="\/assets/.test(html), 'no root-absolute asset URLs (must work under /AzyronWebsite/)');

  const js = await fetch(`${baseUrl}/assets/js/github-data.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const missing = await fetch(`${baseUrl}/nope-not-a-page`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /404/);
});

/* ---------------------------------------------------------------- visitors */

/**
 * These are the endpoints that make "unique visitors" real: the number lives in
 * the server's log, not in a browser, so every visitor sees the same total.
 */

const vid = (n) => String(n).padStart(4, '0').repeat(8); // 32 chars, valid shape

async function heartbeat(visitorId, headers = {}) {
  return fetch(`${baseUrl}/api/visits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ visitorId }),
  });
}

test('a brand-new visitor raises the shared unique total to 1', async () => {
  const res = await heartbeat(vid(1));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.unique, 1);
  assert.equal(body.active, 1);
  assert.equal(body.isNew, true);
  assert.equal(body.windowMs, 30_000);
});

test('refreshing 100 times keeps the unique total at 1', async () => {
  for (let i = 0; i < 100; i += 1) await heartbeat(vid(1));
  const totals = await (await fetch(`${baseUrl}/api/visits`)).json();
  assert.equal(totals.unique, 1, 'repeat visits must never inflate uniques');
  assert.equal(totals.active, 1);
});

test('ten tabs of the same visitor are counted once', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => heartbeat(vid(1))));
  const bodies = await Promise.all(results.map((r) => r.json()));
  assert.equal(bodies.filter((b) => b.isNew).length, 0, 'visitor #1 is already known');
  const totals = await (await fetch(`${baseUrl}/api/visits`)).json();
  assert.equal(totals.unique, 1);
});

test('a second visitor makes it 2, and both are active', async () => {
  await heartbeat(vid(2));
  const totals = await (await fetch(`${baseUrl}/api/visits`)).json();
  assert.equal(totals.unique, 2);
  assert.equal(totals.active, 2);
});

test('active is separate from unique and is lower when a visitor goes quiet', async () => {
  // visitor 1 has not pinged for the whole test run; ask for totals "later"
  const body = await (await fetch(`${baseUrl}/api/visits/health`)).json();
  assert.equal(body.unique, 2);
  assert.equal(body.activeWindowMs, 30_000);
  assert.ok(body.unique >= body.active, 'active can never exceed unique');
});

test('junk visitor ids are rejected with 400 and do not change the total', async () => {
  const before = await (await fetch(`${baseUrl}/api/visits`)).json();
  for (const bad of ['', 'short', 'has spaces here and is long enough', 'x'.repeat(200), 42]) {
    const res = await heartbeat(bad);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal((await res.json()).ok, false);
  }
  const noBody = await fetch(`${baseUrl}/api/visits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noBody.status, 400);

  const after = await (await fetch(`${baseUrl}/api/visits`)).json();
  assert.equal(after.unique, before.unique, 'rejected ids must not be counted');
});

test('the API answers the GitHub Pages origin with CORS headers', async () => {
  const res = await fetch(`${baseUrl}/api/visits`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://blazemc125.github.io',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://blazemc125.github.io');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers'), /content-type/i);

  const get = await fetch(`${baseUrl}/api/visits`, {
    headers: { origin: 'https://blazemc125.github.io' },
  });
  assert.equal(get.headers.get('access-control-allow-origin'), 'https://blazemc125.github.io');
  assert.match(get.headers.get('cache-control'), /no-store/);
});

test('an unknown origin gets no CORS grant (no wildcard)', async () => {
  const res = await fetch(`${baseUrl}/api/visits`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});
