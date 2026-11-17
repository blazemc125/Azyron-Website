/* =============================================================================
   Tests for docs/assets/js/live-stats.js

   Run: node --test scripts/test-live-stats.mjs
   ============================================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCount,
  parseCount,
  sharePercent,
  easeOutCubic,
  interpolate,
  animationDuration,
  relativeLabel,
  liveState,
  pickAssetByKind,
  buildLiveModel,
  LIVE_LABELS,
} from '../docs/assets/js/live-stats.js';

/* ------------------------------------------------------------------ format */

test('formatCount renders thousands separators and never invents a zero', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(7), '7');
  assert.equal(formatCount(1234), '1,234');
  assert.equal(formatCount(1234567), '1,234,567');
  // unknown values must be visibly unknown, not 0
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount('nope'), '—');
});

test('parseCount reads a rendered figure back and survives junk', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('  42 '), 42);
  assert.equal(parseCount('—'), 0);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount(99), 99);
});

/* -------------------------------------------------------------------- maths */

test('sharePercent is safe at zero and clamped to 0…100', () => {
  assert.equal(sharePercent(0, 0), 0);
  assert.equal(sharePercent(5, 0), 0);
  assert.equal(sharePercent(1, 4), 25);
  assert.equal(sharePercent(4, 4), 100);
  assert.equal(sharePercent(9, 4), 100); // never overflows the bar
  assert.equal(sharePercent(-3, 4), 0);
});

test('interpolate counts up smoothly and lands exactly on the target', () => {
  assert.equal(interpolate(0, 100, 0), 0);
  assert.equal(interpolate(0, 100, 1), 100);
  const mid = interpolate(0, 100, 0.5);
  assert.ok(mid > 0 && mid < 100, `mid=${mid}`);
  // ease-out: past the halfway point early on
  assert.ok(mid > 50, `mid=${mid} should lead a linear ramp`);
});

test('easeOutCubic is clamped, monotonic and hits both ends', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-5), 0);
  assert.equal(easeOutCubic(9), 1);
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const v = easeOutCubic(t);
    assert.ok(v >= prev, 'must be monotonic');
    prev = v;
  }
});

test('animationDuration scales with the size of the jump but never exceeds the poll window', () => {
  assert.equal(animationDuration(5, 5), 0);
  const small = animationDuration(0, 1);
  const big = animationDuration(0, 100_000);
  assert.ok(small > 0, 'a +1 must still animate');
  assert.ok(big > small, 'a big jump should take longer');
  // must always finish well inside a 1-second refresh, or the number would
  // still be moving when the next value arrives
  assert.ok(big <= 620, `big=${big} exceeds the 620ms cap`);
  assert.ok(big < 1000);
});

/* ---------------------------------------------------------------- timestamps */

test('relativeLabel says "just now" inside the refresh window', () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeLabel(now, now), 'Updated just now');
  assert.equal(relativeLabel(now - 1500, now), 'Updated just now');
  assert.equal(relativeLabel(now - 12_000, now), 'Updated 12s ago');
  assert.equal(relativeLabel(now - 5 * 60_000, now), 'Updated 5m ago');
  assert.equal(relativeLabel(now - 3 * 3600_000, now), 'Updated 3h ago');
  assert.equal(relativeLabel(now - 2 * 86400_000, now), 'Updated 2d ago');
});

test('relativeLabel never claims an update it has not had', () => {
  assert.equal(relativeLabel(null), 'waiting for first update');
  assert.equal(relativeLabel(undefined), 'waiting for first update');
  assert.equal(relativeLabel('bogus'), 'waiting for first update');
  // clock skew (a timestamp in the future) must not say "-3s ago"
  const now = 1_700_000_000_000;
  assert.equal(relativeLabel(now + 5000, now), 'Updated just now');
});

/* ----------------------------------------------------------------- LIVE badge */

test('the LIVE badge is never shown for data that is not live', () => {
  assert.equal(liveState({ ok: true, stale: false, ageMs: 900 }), 'live');
  assert.equal(liveState({ ok: true, stale: true, ageMs: 900 }), 'cached');
  assert.equal(liveState({ ok: false }), 'offline');
  // a successful read that is now far too old is not "live" either
  assert.equal(liveState({ ok: true, stale: false, ageMs: 90_000, maxAgeMs: 20_000 }), 'cached');
  assert.deepEqual(Object.keys(LIVE_LABELS).sort(), ['cached', 'live', 'offline']);
});

/* ------------------------------------------------------------- asset picking */

test('pickAssetByKind matches the real file extensions only', () => {
  const assets = [
    { id: 1, name: 'azyronclient-1.0.0.jar', downloads: 10 },
    { id: 2, name: 'azyron-client-1.0.0.mrpack', downloads: 5 },
    { id: 3, name: 'checksums.txt', downloads: 0 },
  ];
  assert.equal(pickAssetByKind(assets, 'jar').id, 1);
  assert.equal(pickAssetByKind(assets, 'mrpack').id, 2);
  assert.equal(pickAssetByKind(assets, 'zip'), null);
  assert.equal(pickAssetByKind([], 'jar'), null);
  // a file merely containing the word must not match
  assert.equal(pickAssetByKind([{ id: 9, name: 'jar-notes.txt' }], 'jar'), null);
});

test('pickAssetByKind prefers the newest file when a kind has several', () => {
  const assets = [
    { id: 1, name: 'old.jar', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 2, name: 'new.jar', updatedAt: '2026-06-01T00:00:00Z' },
  ];
  assert.equal(pickAssetByKind(assets, 'jar').id, 2);
});

/* ---------------------------------------------------------------- the model */

const release = {
  ok: true,
  stale: false,
  version: '1.0.0',
  fetchedAt: '2026-11-17T15:00:00.000Z',
  assets: [
    { id: 1, name: 'azyronclient-1.0.0.jar', downloads: 12, sizeLabel: '161 KB', updatedAt: '2026-11-17T05:54:56Z' },
    { id: 2, name: 'azyron-client-1.0.0.mrpack', downloads: 5, sizeLabel: '6.9 MB', updatedAt: '2026-11-17T05:54:56Z' },
  ],
};

const sinceLaunch = {
  total: 2,
  byKind: { jar: 2, mrpack: 0 },
  hasBaseline: true,
  perAsset: [
    { id: 1, name: 'azyronclient-1.0.0.jar', kind: 'jar', live: 12, baseline: 10, since: 2 },
    { id: 2, name: 'azyron-client-1.0.0.mrpack', kind: 'mrpack', live: 5, baseline: 5, since: 0 },
  ],
};

test('buildLiveModel keeps JAR and MRPACK separate and shows both totals', () => {
  const now = new Date('2026-11-17T15:00:00.500Z').getTime();
  const model = buildLiveModel(release, sinceLaunch, now);

  assert.equal(model.state, 'live');
  assert.equal(model.total, 2, 'combined since-launch total');

  // JAR: all-time 12, since launch 2
  assert.equal(model.jar.total, 12);
  assert.equal(model.jar.live, 2);
  assert.equal(model.jar.name, 'azyronclient-1.0.0.jar');
  assert.equal(model.jar.sizeLabel, '161 KB');

  // MRPACK tracked independently
  assert.equal(model.mrpack.total, 5);
  assert.equal(model.mrpack.live, 0);

  // shares are of the combined since-launch total
  assert.equal(model.jar.share, 100);
  assert.equal(model.mrpack.share, 0);
  assert.equal(model.versionLabel, 'v1.0.0');
});

test('an empty since-launch total never divides by zero', () => {
  const zero = { total: 0, byKind: { jar: 0, mrpack: 0 }, hasBaseline: true, perAsset: [] };
  const model = buildLiveModel(release, zero);
  assert.equal(model.total, 0);
  assert.equal(model.jar.share, 0);
  assert.equal(model.mrpack.share, 0);
  assert.equal(model.jar.live, 0, 'unknown assets must not become NaN');
});

test('a release without a baseline reports null, not GitHub history', () => {
  const model = buildLiveModel(release, { total: 0, hasBaseline: false, perAsset: [] });
  assert.equal(model.total, null, 'must not present all-time history as since-launch');
});

test('offline and stale payloads are labelled honestly', () => {
  const offline = buildLiveModel({ ok: false, assets: [], fetchedAt: null }, null);
  assert.equal(offline.state, 'offline');
  assert.equal(offline.jar.name, 'Not in this release');

  const stale = buildLiveModel({ ...release, ok: true, stale: true }, sinceLaunch);
  assert.equal(stale.state, 'cached');

  const old = buildLiveModel({ ...release, fetchedAt: '2026-11-17T14:00:00.000Z' }, sinceLaunch,
    new Date('2026-11-17T15:00:00.000Z').getTime());
  assert.equal(old.state, 'cached', 'a read older than the ceiling is not live');
});

test('the section contains no fabricated numbers', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../docs/assets/js/live-stats.js', import.meta.url), 'utf8');

  // No randomness, no seeded/hard-coded download figures.
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /\bfake\b/i);
  assert.doesNotMatch(source, /downloads\s*[:=]\s*\d{2,}/, 'no hard-coded download totals');

  // Every figure must be derived from GitHub's counters minus the baseline.
  assert.match(source, /sinceLaunch\?\.perAsset/);
  assert.match(source, /asset\.downloads|jar\?\.downloads/);
});
