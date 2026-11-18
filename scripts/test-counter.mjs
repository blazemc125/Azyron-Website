#!/usr/bin/env node
/**
 * Unit tests for the "Downloads Since Launch" counter (docs/assets/js/counter.js).
 *
 * These run in CI and locally (`node --test scripts/`). They exist to prove the
 * two properties that matter:
 *   1. the counter STARTS AT ZERO — GitHub's historical counts never leak into it;
 *   2. it only ever increments by a REAL difference in GitHub's own counters,
 *      tracked separately for JAR and MRPACK, and can never go negative.
 */

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSinceLaunch, parseBaseline, BASELINE_URL } from '../docs/assets/js/counter.js';

const BASELINE_RAW = JSON.parse(readFileSync(new URL('../docs/data/counter-baseline.json', import.meta.url), 'utf8'));
const BASELINE = parseBaseline(BASELINE_RAW);

// The baseline is moved by scripts/reset-baseline.mjs, so these tests must not
// hard-code its numbers — they read the snapshot and derive expectations from it.
// That way a reset can never silently desync the suite from the shipped file.
const JAR_ID = '757856668';
const MRPACK_ID = '757856664';
const JAR = BASELINE_RAW.baseline[JAR_ID];
const MRPACK = BASELINE_RAW.baseline[MRPACK_ID];

const releaseWith = (jar, mrpack) => ({
  assets: [
    { id: 757856664, name: 'azyron-client-1.0.0.mrpack', downloads: mrpack },
    { id: 757856668, name: 'azyronclient-1.0.0.jar', downloads: jar },
  ],
});

test('baseline file parses and matches the launch snapshot shape', () => {
  assert.ok(BASELINE, 'baseline should parse');
  assert.ok(Number.isFinite(JAR) && Number.isFinite(MRPACK), 'both release assets must be in the snapshot');
  assert.equal(BASELINE.baselineTotal, JAR + MRPACK);
  assert.equal(BASELINE.baseline[JAR_ID], JAR);
  assert.equal(BASELINE.baseline[MRPACK_ID], MRPACK);
  assert.match(BASELINE.launchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('the displayed total is ZERO at launch, not GitHub history', () => {
  const result = computeSinceLaunch(releaseWith(JAR, MRPACK), BASELINE);
  assert.equal(result.total, 0, 'must start from zero');
  assert.equal(result.byKind.jar, 0);
  assert.equal(result.byKind.mrpack, 0);
  assert.equal(result.liveTotal, JAR + MRPACK, 'GitHub history is still available, but not shown as the counter');
  assert.equal(result.baselineTotal, JAR + MRPACK);
});

test('each real download increments the total and its own kind', () => {
  let result = computeSinceLaunch(releaseWith(JAR + 1, MRPACK), BASELINE);
  assert.equal(result.total, 1);
  assert.equal(result.byKind.jar, 1);
  assert.equal(result.byKind.mrpack, 0);

  result = computeSinceLaunch(releaseWith(JAR + 3, MRPACK + 2), BASELINE);
  assert.equal(result.total, 5);
  assert.equal(result.byKind.jar, 3);
  assert.equal(result.byKind.mrpack, 2);
});

test('JAR and MRPACK counters are independent', () => {
  const jarOnly = computeSinceLaunch(releaseWith(JAR + 2, MRPACK), BASELINE);
  const mrpackOnly = computeSinceLaunch(releaseWith(JAR, MRPACK + 4), BASELINE);
  assert.equal(jarOnly.byKind.jar, 2);
  assert.equal(jarOnly.byKind.mrpack, 0);
  assert.equal(mrpackOnly.byKind.jar, 0);
  assert.equal(mrpackOnly.byKind.mrpack, 4);
});

test('per-asset figures line up with the release assets', () => {
  const result = computeSinceLaunch(releaseWith(JAR + 2, MRPACK + 3), BASELINE);
  const jar = result.perAsset.find((p) => p.kind === 'jar');
  const mrpack = result.perAsset.find((p) => p.kind === 'mrpack');
  assert.deepEqual(
    { name: jar.name, live: jar.live, baseline: jar.baseline, since: jar.since },
    { name: 'azyronclient-1.0.0.jar', live: JAR + 2, baseline: JAR, since: 2 },
  );
  assert.equal(mrpack.since, 3);
  assert.equal(result.total, jar.since + mrpack.since);
});

test('never shows a negative number if GitHub reports less than the snapshot', () => {
  const result = computeSinceLaunch(releaseWith(0, 0), BASELINE);
  assert.equal(result.total, 0);
  assert.equal(result.byKind.jar, 0);
  assert.equal(result.byKind.mrpack, 0);
  assert.equal(result.perAsset.every((p) => p.since >= 0), true);
  assert.equal(result.perAsset.every((p) => p.clamped), true);
});

test('a new asset published after launch counts from zero', () => {
  const release = {
    assets: [
      ...releaseWith(JAR, MRPACK).assets,
      { id: 999, name: 'azyronclient-1.1.0.jar', downloads: 3 }, // unknown to the baseline
    ],
  };
  const result = computeSinceLaunch(release, BASELINE);
  assert.equal(result.total, 3, 'an asset absent from the snapshot has a baseline of 0');
  assert.equal(result.byKind.jar, 3);
});

test('without a baseline the UI is told, rather than shown an un-baselined number', () => {
  const result = computeSinceLaunch(releaseWith(JAR, MRPACK), null);
  assert.equal(result.hasBaseline, false);
});

test('baseline falls back to names when asset ids change', () => {
  const release = {
    assets: [
      { id: 111, name: 'azyronclient-1.0.0.jar', downloads: JAR + 2 },
      { id: 222, name: 'azyron-client-1.0.0.mrpack', downloads: MRPACK },
    ],
  };
  const result = computeSinceLaunch(release, BASELINE);
  assert.equal(result.byKind.jar, 2, 'id changed → matched by file name');
  assert.equal(result.total, 2);
});

test('malformed baselines are rejected instead of producing wrong numbers', () => {
  assert.equal(parseBaseline(null), null);
  assert.equal(parseBaseline({}), null);
  assert.equal(parseBaseline({ baseline: {} }), null);
  assert.equal(parseBaseline({ nonsense: true }), null);
});

test('the baseline URL is relative so it works under /Azyron-Website/', () => {
  assert.equal(BASELINE_URL, './data/counter-baseline.json');
  assert.ok(!BASELINE_URL.startsWith('/'), 'must not be root-absolute');
});

test('the counter is not hardcoded anywhere in the shipped JS', () => {
  const app = readFileSync(new URL('../docs/assets/js/app.js', import.meta.url), 'utf8');
  const counter = readFileSync(new URL('../docs/assets/js/counter.js', import.meta.url), 'utf8');
  // no literal totals such as "totalDownloads = 1234"
  assert.ok(!/totalDownloads['"]?\s*[,)]\s*['"]?\d{2,}/.test(app));
  assert.ok(!/Math\.random/.test(app), 'counter must never be randomised');
  assert.ok(!/Math\.random/.test(counter), 'counter must never be randomised');
});

/* --------------------------------------------------------------- the reset */

test('the shipped baseline puts the public counters back at zero', async () => {
  // After a reset, live GitHub counts equal the baseline exactly, so every
  // since-launch figure must read 0 — hero, both live cards and the total.
  const raw = JSON.parse(
    await readFile(new URL('../docs/data/counter-baseline.json', import.meta.url), 'utf8'),
  );
  const parsed = parseBaseline(raw);
  assert.ok(parsed, 'the shipped baseline must be valid');

  const release = {
    assets: [
      { id: 757856668, name: 'azyronclient-1.0.0.jar', downloads: raw.baseline['757856668'] },
      { id: 757856664, name: 'azyron-client-1.0.0.mrpack', downloads: raw.baseline['757856664'] },
    ],
  };

  const since = computeSinceLaunch(release, parsed);
  assert.equal(since.total, 0);
  assert.equal(since.byKind.jar, 0);
  assert.equal(since.byKind.mrpack, 0);
  assert.equal(since.hasBaseline, true);
  assert.ok(since.perAsset.every((entry) => entry.since === 0 && !entry.clamped));
});

test('a reset baseline never makes the counter go backwards or negative', async () => {
  const raw = JSON.parse(
    await readFile(new URL('../docs/data/counter-baseline.json', import.meta.url), 'utf8'),
  );
  const parsed = parseBaseline(raw);

  // one real download after the reset on each file
  const bumped = computeSinceLaunch(
    {
      assets: [
        { id: 757856668, name: 'azyronclient-1.0.0.jar', downloads: raw.baseline['757856668'] + 1 },
        { id: 757856664, name: 'azyron-client-1.0.0.mrpack', downloads: raw.baseline['757856664'] + 1 },
      ],
    },
    parsed,
  );
  assert.equal(bumped.total, 2);
  assert.equal(bumped.byKind.jar, 1);
  assert.equal(bumped.byKind.mrpack, 1);

  // GitHub ever reporting fewer than the baseline clamps to 0, never a negative
  const lower = computeSinceLaunch(
    { assets: [{ id: 757856668, name: 'azyronclient-1.0.0.jar', downloads: 0 }] },
    parsed,
  );
  assert.equal(lower.total, 0);
  assert.ok(lower.perAsset[0].clamped, 'must report the clamp instead of lying');
});

test('the baseline is an exact snapshot (by-id, by-name and by-kind agree)', async () => {
  const raw = JSON.parse(
    await readFile(new URL('../docs/data/counter-baseline.json', import.meta.url), 'utf8'),
  );

  assert.match(raw.launchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'launchedAt must be a UTC timestamp');

  const byIdTotal = Object.values(raw.baseline).reduce((a, b) => a + b, 0);
  assert.equal(byIdTotal, raw.baselineTotal, 'baselineTotal must equal the per-asset snapshot');
  assert.equal(
    Object.values(raw.baselineByKind).reduce((a, b) => a + b, 0),
    raw.baselineTotal,
    'per-kind totals must agree with the overall total',
  );
  for (const [name, count] of Object.entries(raw.baselineByName)) {
    assert.ok(Object.values(raw.baseline).includes(count), `${name} has no matching per-id entry`);
  }
});
