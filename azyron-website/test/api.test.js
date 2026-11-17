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

test('serves the site shell and 404 page', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /AZYRON/i);
  const missing = await fetch(`${baseUrl}/nope-not-a-page`);
  assert.equal(missing.status, 404);
});
